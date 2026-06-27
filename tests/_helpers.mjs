/**
 * Test environment: an isolated HOME + cwd + real SessionManager + a mock
 * for the AI SDK's `complete` function, with the plan-mode extension loaded
 * via jiti and all the runtime hooks captured for inspection.
 *
 * Always call cleanup() in a `finally` block. Tests in this suite must
 * run serially because they mutate process.env.HOME and globalThis.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const EXTENSION_PATH = resolve(__dirname, "../extensions/plan-mode.ts");

export class TestEnv {
	constructor() {
		this.tmpHome = mkdtempSync(join(tmpdir(), "plan-home-"));
		this.tmpDir = mkdtempSync(join(tmpdir(), "plan-cwd-"));
		this.origHome = process.env.HOME;
		this.origUserProfile = process.env.USERPROFILE;
		process.env.HOME = this.tmpHome;
		if (process.platform === "win32") process.env.USERPROFILE = this.tmpHome;

		mkdirSync(join(this.tmpDir, ".pi"), { recursive: true });
		const sessionsDir = join(this.tmpDir, "sessions");
		mkdirSync(sessionsDir, { recursive: true });
		this.sessionManager = SessionManager.create(this.tmpDir, sessionsDir);

		// Captured runtime state.
		this.events = {};
		this.commands = {};
		this.notifications = [];
		this.calls = []; // mock complete invocations
		this.responses = []; // queued mock responses
		this.setModelResults = []; // pi.setModel args
		this.thinkingLevelCalls = []; // pi.setThinkingLevel args
	}

	writeConfig(config) {
		writeFileSync(
			join(this.tmpDir, ".pi", "plan-mode.json"),
			JSON.stringify(config, null, 2),
		);
	}

	setMockResponses(responses) {
		this.responses = responses;
	}

	appendUserMessage(text) {
		this.sessionManager.appendMessage({
			role: "user",
			content: text,
			timestamp: Date.now(),
		});
	}

	appendAssistantMessage(text, { stopReason = "stop" } = {}) {
		this.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text }],
			timestamp: Date.now(),
			stopReason,
		});
	}

	async loadExtension() {
		const mockPath = join(this.tmpDir, "_mock-complete.mjs");
		writeFileSync(
			mockPath,
			`export const complete = async (model, context) => {
				const state = globalThis.__planTestMock;
				state.calls.push({
					model: { id: model.id, provider: model.provider },
					prompt: context.messages[0].content[0].text,
				});
				const r = state.responses.shift() ?? {
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					stopReason: "stop",
					timestamp: Date.now(),
				};
				return r;
			};
			export const getModel = () => undefined;
			export const getModels = () => [];
			export const getProviders = () => [];`,
		);
		globalThis.__planTestMock = this;

		const jiti = createJiti(import.meta.url, {
			interopDefault: true,
			moduleCache: false,
			alias: { "@earendil-works/pi-ai/compat": pathToFileURL(mockPath).href },
		});
		const m = await jiti.import(EXTENSION_PATH);
		const ext = m.default;
		ext({
			registerCommand: (name, cmd) => {
				this.commands[name] = cmd;
			},
			on: (e, h) => {
				this.events[e] = h;
			},
			appendEntry: () => {},
			getThinkingLevel: () => "high",
			setThinkingLevel: (level) => {
				this.thinkingLevelCalls.push(level);
			},
			setModel: async (model) => {
				this.setModelResults.push(model);
				return true;
			},
		});
	}

	buildCtx({
		provider = "opencode-go",
		modelId = "m",
		models,
		hasUI = true,
		mode = "tui",
	} = {}) {
		const modelSpecs = models ?? [{ provider, id: modelId }];
		const allModels = modelSpecs.map((m) => ({
			id: m.id,
			provider: { id: m.provider },
			api: "openai-completions",
			maxTokens: 4096,
			contextWindow: 8192,
			input: ["text"],
			thinkingLevelMap: {},
		}));
		const currentModel =
			allModels.find((m) => m.provider.id === provider && m.id === modelId) ??
			allModels[0];
		return {
			cwd: this.tmpDir,
			hasUI,
			mode,
			sessionManager: this.sessionManager,
			modelRegistry: {
				find: (p, id) =>
					allModels.find((m) => m.provider.id === p && m.id === id),
				getAll: () => allModels,
				getApiKeyAndHeaders: async () => ({
					ok: true,
					apiKey: "k",
					headers: {},
				}),
			},
			model: currentModel,
			ui: {
				notify: (message, type) => {
					this.notifications.push({ message, type });
				},
				select: async () => undefined, // user cancels by default
				input: async () => undefined,
				confirm: async () => false,
				editor: async () => undefined,
				setStatus: () => {},
				theme: { fg: (_color, text) => text },
			},
			signal: undefined,
		};
	}

	async startSession() {
		const ctx = this.buildCtx();
		await this.events.session_start({ reason: "start" }, ctx);
		return ctx;
	}

	cleanup() {
		if (this.origHome !== undefined) process.env.HOME = this.origHome;
		else delete process.env.HOME;
		if (this.origUserProfile !== undefined && process.platform === "win32") {
			process.env.USERPROFILE = this.origUserProfile;
		}
		rmSync(this.tmpHome, { recursive: true, force: true });
		rmSync(this.tmpDir, { recursive: true, force: true });
	}
}
