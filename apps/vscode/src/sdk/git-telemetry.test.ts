import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import type { ClineCoreStartInput, ITelemetryService, TelemetryProperties } from "@cline/core"
import type { AgentRuntimeEvent } from "@cline/shared"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readGitSnapshot, sanitizeGitRemote, VscodeGitTelemetry } from "./git-telemetry"

const vscodeGit = vi.hoisted(() => ({
	available: true,
	workspaceFolders: undefined as { uri: { fsPath: string } }[] | undefined,
	head: undefined as string | undefined,
	changed: new Set<() => void>(),
	opened: new Set<() => void>(),
	getRepository: vi.fn(),
}))
vi.mock("vscode", () => ({
	workspace: {
		get workspaceFolders() {
			return vscodeGit.workspaceFolders
		},
	},
	Uri: { file: (fsPath: string) => ({ fsPath }) },
	extensions: {
		getExtension: () =>
			vscodeGit.available
				? {
						isActive: true,
						exports: {
							getAPI: () => ({
								getRepository: vscodeGit.getRepository,
								onDidOpenRepository: (listener: () => void) => {
									vscodeGit.opened.add(listener)
									return { dispose: () => vscodeGit.opened.delete(listener) }
								},
							}),
						},
					}
				: undefined,
	},
}))

const execFileAsync = promisify(execFile)
const tmp = resolve(import.meta.dirname, "../../../../tmp")
let cwd: string
let enabled: boolean
let events: { event: string; properties?: TelemetryProperties }[]
let observers: VscodeGitTelemetry[]
let telemetry: ITelemetryService
const git = async (...args: string[]) =>
	(
		await execFileAsync("git", ["-c", "commit.gpgsign=false", "-c", `core.hooksPath=${join(cwd, "no-hooks")}`, ...args], {
			cwd,
		})
	).stdout.trim()
const commit = async () => {
	await git("commit", "--allow-empty", "-m", "test")
	return git("rev-parse", "HEAD")
}
function observer(config: Partial<ClineCoreStartInput["config"]> = {}) {
	const result = new VscodeGitTelemetry(
		{
			sessionId: "task-1",
			cwd,
			providerId: "cline",
			modelId: "test",
			systemPrompt: "test",
			enableTools: true,
			enableSpawnAgent: false,
			enableAgentTeams: false,
			...config,
		},
		telemetry,
	)
	observers.push(result)
	return result
}
function runtimeEvent(type: string) {
	return { type, snapshot: { agentId: "agent-1", runId: "run-1", iteration: 2 } } as AgentRuntimeEvent
}
async function beginModel(tracker: VscodeGitTelemetry, iteration = 2) {
	const hooks = tracker.configure().hooks
	const snapshot = { ...runtimeEvent("turn-started").snapshot, iteration }
	await hooks?.beforeModel?.({ snapshot, request: { messages: [], tools: [] } })
	return (requestId?: string) =>
		hooks?.afterModel?.({
			snapshot,
			requestId,
			finishReason: "stop",
			assistantMessage: { id: "assistant", role: "assistant", content: [], createdAt: Date.now() },
		})
}

beforeEach(async () => {
	await mkdir(tmp, { recursive: true })
	cwd = await mkdtemp(join(tmp, "git-telemetry-"))
	// Non-repo fixtures must not discover the surrounding Cline checkout.
	vi.stubEnv("GIT_CEILING_DIRECTORIES", tmp)
	await git("init", "-b", "main")
	await git("config", "user.email", "test@example.test")
	await git("config", "user.name", "Test")
	enabled = true
	events = []
	observers = []
	telemetry = {
		isEnabled: () => enabled,
		capture: (event) => {
			events.push(event)
		},
		setDistinctId() {},
		setMetadata() {},
		updateMetadata() {},
		setCommonProperties() {},
		updateCommonProperties() {},
		captureRequired() {},
		recordCounter() {},
		recordHistogram() {},
		recordGauge() {},
		flush: async () => {},
		dispose: async () => {},
	}
	vscodeGit.available = true
	vscodeGit.workspaceFolders = [{ uri: { fsPath: cwd } }]
	vscodeGit.head = undefined
	vscodeGit.changed.clear()
	vscodeGit.opened.clear()
	vscodeGit.getRepository.mockReset().mockReturnValue({
		state: {
			get HEAD() {
				return vscodeGit.head ? { commit: vscodeGit.head } : undefined
			},
			onDidChange: (listener: () => void) => {
				vscodeGit.changed.add(listener)
				return { dispose: () => vscodeGit.changed.delete(listener) }
			},
		},
	})
})
afterEach(async () => {
	for (const item of observers) item.dispose()
	vi.unstubAllEnvs()
	await rm(cwd, { recursive: true, force: true })
})

describe("Git snapshots", () => {
	it("distinguishes unborn, clean, untracked, ignored, staged, and unstaged states", async () => {
		const clean = { dirty: false, staged: false, unstaged: false, untracked: false }
		expect(await readGitSnapshot(cwd)).toMatchObject({ state: "unborn", branch: "main", ...clean, remote_state: "none" })
		const head = await commit()
		expect(await readGitSnapshot(cwd)).toMatchObject({ state: "ok", head_sha: head, ...clean })
		await writeFile(join(cwd, "untracked.txt"), "new file")
		expect(await readGitSnapshot(cwd)).toMatchObject({ dirty: true, staged: false, unstaged: false, untracked: true })
		await writeFile(join(cwd, ".git", "info", "exclude"), "untracked.txt\n")
		expect(await readGitSnapshot(cwd)).toMatchObject(clean)
		await writeFile(join(cwd, "tracked.txt"), "initial")
		await git("add", "tracked.txt")
		expect(await readGitSnapshot(cwd)).toMatchObject({ dirty: true, staged: true, unstaged: false, untracked: false })
		await commit()
		await writeFile(join(cwd, "tracked.txt"), "modified")
		expect(await readGitSnapshot(cwd)).toMatchObject({ dirty: true, staged: false, unstaged: true, untracked: false })
		await git("add", "tracked.txt")
		await writeFile(join(cwd, "tracked.txt"), "modified again")
		await writeFile(join(cwd, "another.txt"), "new file")
		expect(await readGitSnapshot(cwd)).toMatchObject({ dirty: true, staged: true, unstaged: true, untracked: true })
	})

	it("includes staged renames and unstaged deletions", async () => {
		await writeFile(join(cwd, "tracked.txt"), "initial")
		await git("add", "tracked.txt")
		await commit()
		await git("config", "status.renames", "true")
		await git("mv", "tracked.txt", "renamed.txt")
		expect(await readGitSnapshot(cwd)).toMatchObject({ dirty: true, staged: true, unstaged: false, untracked: false })
		await rm(join(cwd, "renamed.txt"))
		expect(await readGitSnapshot(cwd)).toMatchObject({ dirty: true, staged: true, unstaged: true, untracked: false })
	})

	it("marks unmerged entries as changes on both index and worktree sides", async () => {
		await writeFile(join(cwd, "conflict.txt"), "base\n")
		await git("add", "conflict.txt")
		await commit()
		await git("checkout", "-b", "other")
		await writeFile(join(cwd, "conflict.txt"), "other\n")
		await git("add", "conflict.txt")
		await commit()
		await git("checkout", "main")
		await writeFile(join(cwd, "conflict.txt"), "main\n")
		await git("add", "conflict.txt")
		await commit()
		await expect(git("merge", "other")).rejects.toThrow()
		expect(await readGitSnapshot(cwd)).toMatchObject({ dirty: true, staged: true, unstaged: true, untracked: false })
	})

	it("reads the actual HEAD for detached checkouts and separate worktrees", async () => {
		const first = await commit()
		const second = await commit()
		const worktree = join(cwd, "other-worktree")
		await git("worktree", "add", "--detach", worktree, first)
		expect(await readGitSnapshot(worktree)).toMatchObject({ state: "ok", head_sha: first })
		expect((await readGitSnapshot(worktree)).branch).toBeUndefined()
		expect((await readGitSnapshot(cwd)).head_sha).toBe(second)
		await git("checkout", "--detach", first)
		expect((await readGitSnapshot(cwd)).head_sha).toBe(first)
	})

	it("distinguishes non-Git directories from unavailable directories", async () => {
		await rm(join(cwd, ".git"), { recursive: true })
		expect(await readGitSnapshot(cwd)).toEqual({ state: "non_git" })
		expect(await readGitSnapshot(join(cwd, "missing"))).toEqual({ state: "unavailable" })
	})

	it("reports unavailable when Git is missing", async () => {
		vi.stubEnv("PATH", join(cwd, "missing-bin"))
		expect(await readGitSnapshot(cwd)).toEqual({ state: "unavailable" })
	})

	it("prefers origin and strips credentials, query parameters, fragments, and local remotes", async () => {
		await git("remote", "add", "upstream", "https://example.test/upstream.git")
		await git("remote", "add", "origin", "https://user:secret@example.test/team/repo.git?token=secret#secret")
		expect((await readGitSnapshot(cwd)).remote_url).toBe("https://example.test/team/repo.git")
		await git("remote", "set-url", "origin", "/private/local/repo")
		expect(await readGitSnapshot(cwd)).toMatchObject({ remote_state: "unsupported" })
		expect((await readGitSnapshot(cwd)).remote_url).toBeUndefined()
		expect(sanitizeGitRemote("git@example.test:team/repo.git")).toBe("ssh://example.test/team/repo.git")
		expect(sanitizeGitRemote("ssh://user:secret@example.test:2222/team/repo.git?secret=x")).toBe(
			"ssh://example.test:2222/team/repo.git",
		)
		for (const value of [
			"file:///private/repo",
			"../repo",
			"C:\\Users\\repo",
			"ext::secret",
			"https://example.test/\nsecret",
		]) {
			expect(sanitizeGitRemote(value)).toBeUndefined()
		}
	})
})

describe("conversation Git telemetry", () => {
	it("emits only state changes across boundaries, including changes back to earlier states", async () => {
		const tracker = observer()
		const snapshot = {
			git: await readGitSnapshot(cwd),
			workspaceRootCount: 1,
			sequence: 1,
			observedAt: new Date().toISOString(),
			context: {},
			headChanged: false,
		}
		tracker["emit"](snapshot, "chat_open")
		for (const boundary of ["model_call", "agent_yield", "idle_head_changed"] as const) {
			tracker["emit"]({ ...snapshot, sequence: 2, observedAt: "later", context: { iteration: 2 } }, boundary, {
				request_id: "different-request",
			})
		}
		expect(events).toHaveLength(1)
		const changes = [
			{ ...snapshot, workspaceRootCount: 2 },
			...[
				{ state: "unavailable" as const },
				{ state: "non_git" as const },
				{ state: "ok" as const },
				{ head_sha: "new-head" },
				{ branch: "other" },
				{ dirty: true },
				{ staged: true },
				{ unstaged: true },
				{ untracked: true },
				{ remote_state: "unsupported" as const },
				{ remote_url: "https://example.test/repo" },
			].map((git) => ({ ...snapshot, git: { ...snapshot.git, ...git } })),
		]
		for (const change of changes) {
			const count = events.length
			tracker["emit"](change, "model_call")
			tracker["emit"](change, "agent_yield")
			expect(events).toHaveLength(count + 1)
			tracker["emit"](snapshot, "model_call")
			expect(events).toHaveLength(count + 2)
		}
	})

	it("does not remember an opted-out or failed emission as the last emitted state", async () => {
		vscodeGit.available = false
		const tracker = observer()
		enabled = false
		await tracker.open()
		enabled = true
		const capture = vi.spyOn(telemetry, "capture").mockImplementationOnce(() => {
			throw new Error("adapter failed")
		})
		await tracker.open()
		expect(events).toHaveLength(0)
		await tracker.open()
		await tracker.open()
		expect(events).toHaveLength(1)
		expect(capture).toHaveBeenCalledTimes(2)
		capture.mockRestore()
	})

	it.each([undefined, 0, 1, 2])("reports the VS Code workspace-folder count (%s), including outside Git", async (count) => {
		vscodeGit.workspaceFolders =
			count === undefined
				? undefined
				: Array.from({ length: count }, (_, i) => ({ uri: { fsPath: join(cwd, `root-${i}`) } }))
		await rm(join(cwd, ".git"), { recursive: true })
		await observer().open()
		expect(events[0].properties).toMatchObject({ workspace_root_count: count ?? 0, git: { state: "non_git" } })
		expect(JSON.stringify(events)).not.toContain(cwd)
	})

	it("records root count at observation time and picks up folder changes on later boundaries", async () => {
		const enabledCheck = vi.spyOn(telemetry, "isEnabled")
		const tracker = observer()
		const finish = await beginModel(tracker)
		await vi.waitFor(() => expect(enabledCheck.mock.calls.length).toBeGreaterThanOrEqual(3))
		vscodeGit.workspaceFolders?.push({ uri: { fsPath: join(cwd, "second-root") } })
		await finish("request-1")
		await vi.waitFor(() => expect(events).toHaveLength(1))
		expect(events[0].properties?.workspace_root_count).toBe(1)
		await tracker.configure().hooks?.onEvent?.(runtimeEvent("run-finished"))
		await vi.waitFor(() => expect(events).toHaveLength(2))
		expect(events[1].properties?.workspace_root_count).toBe(2)
	})

	it("preserves config values and uses its identity for telemetry and request matching", async () => {
		const delegate = vi.fn(async () => new Response("ok", { headers: { "X-Request-ID": "request-1" } }))
		const providerConfig = {
			providerId: "cline",
			modelId: "nested-model",
			apiKey: "preserved-key",
			fetch: delegate as unknown as typeof fetch,
		}
		const tracker = observer({ sessionId: "custom-task", providerId: "cline-pass", modelId: "top-model", providerConfig })
		const config = tracker.configure()
		expect(config).toMatchObject({
			sessionId: "custom-task",
			providerId: "cline-pass",
			modelId: "top-model",
			cwd,
			systemPrompt: "test",
		})
		expect(config.providerConfig).toMatchObject({ providerId: "cline", modelId: "nested-model", apiKey: "preserved-key" })
		expect(providerConfig.fetch).toBe(delegate)
		expect(config.providerConfig?.fetch).toBe(delegate)
		const finish = await beginModel(tracker)
		await finish("request-1")
		await vi.waitFor(() => expect(events).toHaveLength(1))
		expect(events[0].properties).toMatchObject({
			sessionId: "custom-task",
			ulid: "custom-task",
			providerId: "cline-pass",
			request_id: "request-1",
			workspace_root_count: 1,
			git: { dirty: false, staged: false, unstaged: false, untracked: false },
		})
		expect(observer({ providerId: "cline-pass" }).configure().providerConfig).toBeUndefined()
	})

	it("does not await Git in either model hook and correlates observations by iteration", async () => {
		const head = await commit()
		const beforeModel = vi.fn(() => ({ options: { preserved: true } }))
		const afterModel = vi.fn(() => ({ stop: true }))
		const tracker = observer({ hooks: { beforeModel, afterModel } })
		const first = await beginModel(tracker, 1)
		const second = await beginModel(tracker, 2)
		// Complete out of order, before the scheduled Git reads can run.
		expect(await second("request-2")).toEqual({ stop: true })
		expect(await first("request-1")).toEqual({ stop: true })
		expect(events).toHaveLength(0)
		expect(beforeModel).toHaveBeenCalledTimes(2)
		expect(afterModel).toHaveBeenCalledTimes(2)
		await vi.waitFor(() => expect(events).toHaveLength(1))
		expect(events[0].properties).toMatchObject({
			request_id: `request-${events[0].properties?.iteration}`,
			boundary: "model_call",
			git: { head_sha: head },
		})
	})

	it.each([undefined, "unsafe header value"])("keeps absent and invalid IDs explicitly unjoined (%s)", async (id) => {
		const tracker = observer()
		const finish = await beginModel(tracker)
		await finish(id)
		await vi.waitFor(() => expect(events).toHaveLength(1))
		expect(events.every((event) => event.properties?.request_id_status === "missing")).toBe(true)
		expect(events.every((event) => event.properties?.request_id === undefined)).toBe(true)
		expect(JSON.stringify(events)).not.toContain("unsafe header value")
	})

	it("respects opt-out before and during a model call", async () => {
		const tracker = observer()
		enabled = false
		const skipped = await beginModel(tracker, 1)
		enabled = true
		await skipped("not-collected")
		const pending = await beginModel(tracker, 2)
		enabled = false
		await pending("also-not-collected")
		await tracker.open()
		expect(events).toEqual([])
	})

	it.each(["opt-out", "close"])("suppresses queued model emission on %s", async (action) => {
		const enabledCheck = vi.spyOn(telemetry, "isEnabled")
		const tracker = observer()
		const finish = await beginModel(tracker)
		// beforeModel, pre-read, and post-read consent checks: Git is already ready.
		await vi.waitFor(() => expect(enabledCheck.mock.calls.length).toBeGreaterThanOrEqual(3))
		finish("request-1")
		if (action === "close") tracker.dispose()
		else enabled = false
		await Promise.resolve()
		expect(events).toEqual([])
	})

	it("ignores inherited subagent hooks and preserves a beforeModel stop control", async () => {
		const tracker = observer()
		const hooks = tracker.configure().hooks
		await hooks?.onEvent?.(runtimeEvent("run-started"))
		const child = { ...runtimeEvent("run-started").snapshot, agentId: "child", runId: "child-run" }
		await hooks?.beforeModel?.({ snapshot: child, request: { messages: [], tools: [] } })
		await hooks?.afterModel?.({
			snapshot: child,
			requestId: "child-request",
			finishReason: "stop",
			assistantMessage: { id: "child", role: "assistant", content: [], createdAt: Date.now() },
		})
		await hooks?.onEvent?.({ type: "run-finished", snapshot: child } as AgentRuntimeEvent)
		const stopped = observer({ hooks: { beforeModel: () => ({ stop: true }) } }).configure().hooks
		expect(await stopped?.beforeModel?.({ snapshot: child, request: { messages: [], tools: [] } })).toEqual({ stop: true })
		expect(events).toEqual([])
	})

	it("captures yield and only HEAD changes while idle, then removes all listeners on close", async () => {
		vscodeGit.head = await commit()
		const originalHook = vi.fn()
		const tracker = observer({ hooks: { onEvent: originalHook } })
		const config = tracker.configure()
		await tracker.open()
		await vi.waitFor(() => expect(vscodeGit.changed.size).toBe(1))
		for (const listener of vscodeGit.changed) listener() // unchanged (e.g. file edit/staging)
		expect(events).toHaveLength(1)
		await config.hooks?.onEvent?.(runtimeEvent("run-started"))
		vscodeGit.head = await commit()
		for (const listener of vscodeGit.changed) listener()
		expect(events).toHaveLength(1)
		await config.hooks?.onEvent?.(runtimeEvent("run-finished"))
		await vi.waitFor(() => expect(events.at(-1)?.properties?.boundary).toBe("agent_yield"))
		vscodeGit.head = await commit()
		for (const listener of vscodeGit.changed) listener()
		await vi.waitFor(() => expect(events.at(-1)?.properties?.boundary).toBe("idle_head_changed"))
		expect(originalHook).toHaveBeenCalledTimes(2)
		expect(vscodeGit.getRepository).toHaveBeenCalledWith({ fsPath: cwd })
		tracker.dispose()
		expect(vscodeGit.changed.size).toBe(0)
		expect(vscodeGit.opened.size).toBe(0)
		const count = events.length
		await config.hooks?.onEvent?.(runtimeEvent("run-failed"))
		expect(events).toHaveLength(count)
	})

	it("keeps the yield's preceding request ID when another model call completes during its Git read", async () => {
		const tracker = observer()
		const first = await beginModel(tracker, 1)
		await first("request-1")
		await vi.waitFor(() => expect(events).toHaveLength(1))
		const enabledCheck = vi.spyOn(telemetry, "isEnabled")
		const second = await beginModel(tracker, 2)
		await vi.waitFor(() => expect(enabledCheck.mock.calls.length).toBeGreaterThanOrEqual(3))
		await writeFile(join(cwd, "new.txt"), "changed")
		await tracker.configure().hooks?.onEvent?.(runtimeEvent("run-finished"))
		await second("request-2")
		await vi.waitFor(() => expect(events.some((event) => event.properties?.boundary === "agent_yield")).toBe(true))
		expect(events.find((event) => event.properties?.boundary === "agent_yield")?.properties?.preceding_request_id).toBe(
			"request-1",
		)
	})

	it("discards model observations after close and cleans up missing afterModel callbacks", async () => {
		const tracker = observer()
		const late = await beginModel(tracker)
		await tracker.configure().hooks?.onEvent?.(runtimeEvent("run-failed"))
		await vi.waitFor(() => expect(events).toHaveLength(1))
		expect(events[0].properties?.boundary).toBe("agent_yield")
		await late("no-longer-pending")
		const closed = await beginModel(tracker)
		tracker.dispose()
		await closed("closed")
		expect(events).toHaveLength(1)
	})

	it("attaches when a previously non-Git directory becomes a repository", async () => {
		const repository = vscodeGit.getRepository()
		vscodeGit.getRepository.mockReturnValue(null)
		await rm(join(cwd, ".git"), { recursive: true })
		await observer().open()
		await vi.waitFor(() => expect(vscodeGit.opened.size).toBe(1))
		expect(events[0].properties?.git).toEqual({ state: "non_git" })
		await git("init", "-b", "main")
		await git("config", "user.name", "Test")
		await git("config", "user.email", "test@example.test")
		vscodeGit.head = await commit()
		vscodeGit.getRepository.mockReturnValue(repository)
		for (const listener of vscodeGit.opened) listener()
		await vi.waitFor(() => expect(events.at(-1)?.properties?.boundary).toBe("idle_head_changed"))
		expect((events.at(-1)?.properties?.git as TelemetryProperties).head_sha).toBe(vscodeGit.head)
	})

	it("uses private keyed workspace IDs, stable across reopenings but distinct across worktrees and tasks", async () => {
		vscodeGit.available = false
		await commit()
		const worktree = join(cwd, "other-worktree")
		await git("worktree", "add", "--detach", worktree, "HEAD")
		const first = observer()
		expect(first.hasOpened).toBe(false)
		await first.open()
		expect(first.hasOpened).toBe(true)
		first.dispose()
		await observer({ cwd: worktree }).open()
		await observer().open()
		await observer({ sessionId: "other-task" }).open()
		expect(events[0].properties?.workspace_id).not.toBe(events[1].properties?.workspace_id)
		expect(events[0].properties?.workspace_id).toBe(events[2].properties?.workspace_id)
		expect(events[0].properties?.observation_window_id).not.toBe(events[2].properties?.observation_window_id)
		expect(events[0].properties?.workspace_id).not.toBe(events[3].properties?.workspace_id)
		const guessableDigest = createHash("sha256")
			.update(`task-1\0${resolve(cwd)}`)
			.digest("hex")
		expect(events[0].properties?.workspace_id).not.toBe(guessableDigest)
		expect(JSON.stringify(events)).not.toContain(cwd)
	})
})
