import { execFile } from "node:child_process"
import { createHmac, randomBytes, randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { setImmediate } from "node:timers/promises"
import { isDeepStrictEqual, promisify } from "node:util"
import { type ClineCoreStartInput, captureGitSnapshot, type GitSnapshotProperties, type ITelemetryService } from "@cline/core"
import type { AgentAfterModelContext, AgentRuntimeEvent, AgentRuntimeStateSnapshot } from "@cline/shared"
import { workspace } from "vscode"

const execFileAsync = promisify(execFile)

// Never exported or persisted. A telemetry recipient cannot test candidate paths.
// ponytail: IDs rotate on host restart; persist the key only if cross-restart identity is needed.
const workspaceIdKey = randomBytes(32)
type GitSnapshot = GitSnapshotProperties["git"]
type GitRuntimeContext = Pick<GitSnapshotProperties, "runId" | "iteration" | "agentId">

// Unlike prompt metadata, telemetry must also exclude query credentials and local remotes.
export function sanitizeGitRemote(remote: string): string | undefined {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: reject unsafe URL input before parsing
	if (!remote || /[\s\\\x00-\x1f]/.test(remote) || /^[a-z]:/i.test(remote)) return undefined
	try {
		const scp = !remote.includes("://") && remote.match(/^(?:[^@/:]+@)?([^/:]+):([^:].*)$/)
		const url = new URL(scp ? `ssh://${scp[1]}/${scp[2]}` : remote)
		if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol) || !url.hostname) return undefined
		url.username = ""
		url.password = ""
		url.search = ""
		url.hash = ""
		return url.toString()
	} catch {
		return undefined
	}
}

export async function readGitSnapshot(cwd: string): Promise<GitSnapshot> {
	const git = async (args: string[]) =>
		(
			await execFileAsync("git", ["-c", "core.fsmonitor=false", ...args], {
				cwd,
				// Bound background work; read identity separately if status exceeds these limits.
				timeout: 1000,
				maxBuffer: 1024 * 1024,
				windowsHide: true,
				env: { ...process.env, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
			})
		).stdout
	let status: string | undefined
	let snapshot: GitSnapshot
	try {
		status = await git(["status", "--porcelain=v2", "--branch", "--untracked-files=normal"])
	} catch (error) {
		// Never export stderr: it can contain local paths, remotes, or credentials.
		const failure = error as { stderr?: string; code?: string; killed?: boolean }
		if (failure.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" && !failure.killed) {
			return { state: failure.stderr?.startsWith("fatal: not a git repository") ? "non_git" : "unavailable" }
		}
	}
	if (status === undefined) {
		// Never infer clean/dirty from truncated status. Preserve cheap identity reads.
		const head = await git(["rev-parse", "--verify", "HEAD"]).catch(() => undefined)
		const branch = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => undefined)
		if (!head && !branch) return { state: "unavailable" }
		snapshot = { state: "partial", ...(head ? { head_sha: head.trim() } : {}), ...(branch ? { branch: branch.trim() } : {}) }
	} else {
		const lines = status.split("\n")
		const head = lines.find((line) => line.startsWith("# branch.oid "))?.slice(13)
		const branch = lines.find((line) => line.startsWith("# branch.head "))?.slice(14)
		if (!head) return { state: "unavailable" }
		snapshot = {
			state: head === "(initial)" ? "unborn" : "ok",
			...(head !== "(initial)" ? { head_sha: head } : {}),
			...(branch && branch !== "(detached)" ? { branch } : {}),
			dirty: lines.some((line) => /^[12u?] /.test(line)),
			// Porcelain v2's XY columns: index, then worktree; unmerged entries set both.
			staged: lines.some((line) => /^[12u] [^.]/.test(line)),
			unstaged: lines.some((line) => /^[12u] .[^.]/.test(line)),
			untracked: lines.some((line) => line.startsWith("? ")),
		}
	}
	try {
		const remotes = (await git(["remote", "-v"]))
			.split("\n")
			.map((line) => line.match(/^(\S+)\s+(\S+)\s+\(fetch\)$/))
			.filter((match) => match !== null)
		const remote = remotes.find((match) => match[1] === "origin") ?? remotes[0]
		const url = remote && sanitizeGitRemote(remote[2])
		snapshot.remote_state = !remote ? "none" : url ? "ok" : "unsupported"
		if (url) snapshot.remote_url = url
	} catch {
		snapshot.remote_state = "unavailable"
	}
	return snapshot
}

/** One observation window for one task's fixed starting directory, never the shell's cwd. */
export class VscodeGitTelemetry {
	private disposed = false
	private opened = false
	private agentId?: string
	private sequence = 0
	private lastEmittedState?: { git: GitSnapshot; workspaceRootCount: number }
	private readonly pendingModels = new Map<string, ReturnType<VscodeGitTelemetry["snapshot"]>>()
	private readonly windowId = randomUUID()
	private readonly workspaceId: string

	constructor(
		private readonly config: ClineCoreStartInput["config"] & { sessionId: string; cwd: string },
		private readonly telemetry: ITelemetryService,
	) {
		// Task-scoped identity separates worktrees without exporting an absolute path.
		this.workspaceId = createHmac("sha256", workspaceIdKey)
			.update(`${config.sessionId}\0${resolve(config.cwd)}`)
			.digest("hex")
	}

	configure(): ClineCoreStartInput["config"] {
		const config = this.config
		const { beforeModel, afterModel, onEvent } = config.hooks ?? {}
		return {
			...config,
			hooks: {
				...config.hooks,
				beforeModel: async (context) => {
					const control = await beforeModel?.(context)
					if (!control?.stop) this.beforeModel(context.snapshot)
					return control
				},
				afterModel: (context) => {
					this.afterModel(context)
					return afterModel?.(context)
				},
				onEvent: async (event) => {
					this.onEvent(event)
					await onEvent?.(event)
				},
			},
		}
	}

	get hasOpened(): boolean {
		return this.opened
	}

	open(): void {
		// Mark successful startup for host cleanup; do not collect or emit yet.
		this.opened = true
	}

	private enabled(): boolean {
		try {
			return !this.disposed && this.telemetry.isEnabled()
		} catch {
			return false // A broken telemetry adapter must not interrupt inference.
		}
	}

	private async snapshot(runtimeContext: GitRuntimeContext) {
		if (!this.enabled()) return undefined
		const sequence = ++this.sequence
		const observedAt = new Date().toISOString()
		const workspaceRootCount = workspace.workspaceFolders?.length ?? 0
		const context = { ...runtimeContext }
		const git = await readGitSnapshot(this.config.cwd)
		if (!this.enabled()) return undefined
		return { git, sequence, observedAt, workspaceRootCount, context }
	}

	private emit(snapshot: NonNullable<Awaited<ReturnType<VscodeGitTelemetry["snapshot"]>>>, requestId?: string) {
		if (!this.enabled()) return
		// Emit the first state, then changes only. Request IDs are not state;
		// consumers must carry observations forward within this observation window.
		const state = { git: snapshot.git, workspaceRootCount: snapshot.workspaceRootCount }
		if (isDeepStrictEqual(state, this.lastEmittedState)) return
		try {
			captureGitSnapshot(this.telemetry, {
				schema_version: 1,
				sessionId: this.config.sessionId,
				ulid: this.config.sessionId,
				providerId: this.config.providerId,
				workspace_id: this.workspaceId,
				workspace_root_count: snapshot.workspaceRootCount,
				observation_window_id: this.windowId,
				observation_sequence: snapshot.sequence,
				observed_at: snapshot.observedAt,
				boundary: "model_call",
				...snapshot.context,
				git: snapshot.git,
				...(requestId ? { request_id: requestId } : {}),
				request_id_status: requestId ? "present" : "missing",
			})
			this.lastEmittedState = state
		} catch {
			// Telemetry must not interrupt inference or Git operations.
		}
	}

	private onEvent(event: AgentRuntimeEvent): void {
		if (this.agentId && event.snapshot.agentId !== this.agentId) return
		if (event.type === "run-started" || event.type === "turn-started") {
			this.agentId ??= event.snapshot.agentId
		} else if (event.type === "run-finished" || event.type === "run-failed") {
			// Early failures/cancellation may never call afterModel.
			for (const key of this.pendingModels.keys()) {
				if (key.startsWith(`${event.snapshot.runId}:`)) this.pendingModels.delete(key)
			}
		}
	}

	private beforeModel({ runId, iteration, agentId }: AgentRuntimeStateSnapshot): void {
		if (!this.enabled() || (this.agentId && agentId !== this.agentId)) return
		// Neither the hook nor inference waits for Git, including subprocess startup.
		const observation = setImmediate()
			.then(() => this.snapshot({ runId, iteration, agentId }))
			.catch(() => undefined)
		this.pendingModels.set(`${runId}:${iteration}`, observation)
	}

	private afterModel({ snapshot: { runId, iteration }, requestId: rawId }: AgentAfterModelContext): void {
		const key = `${runId}:${iteration}`
		const observation = this.pendingModels.get(key)
		this.pendingModels.delete(key)
		if (!observation || !this.enabled()) return
		const id = rawId?.trim()
		const requestId = id && /^[\w-]{1,128}$/.test(id) ? id : undefined
		void observation
			.then((snapshot) => {
				if (snapshot) this.emit(snapshot, requestId)
			})
			.catch(() => {})
	}

	dispose(): void {
		this.disposed = true
		this.pendingModels.clear()
	}
}
