/**
 * Plan Mode Extension
 *
 * Adds /plan, /endplan, and /writeplan commands.
 *
 * - /plan              switches to the configured plan model, disables blocked
 * tools, and appends planning instructions to the system prompt
 * so the model produces a numbered markdown implementation plan.
 * - /writeplan [file]  Saves the last assistant response to PLAN.md (or the
 * specified file). If the file already exists, prompts for
 * write / append / clear / delete.
 * - /endplan           restores the previous model and thinking level.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	appendFileSync,
	unlinkSync,
} from "node:fs";
import { resolve } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

interface PlanModeConfig {
	provider?: string;
	model?: string;
	thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	planFile?: string; // Kept in config schema as requested
	instructions?: string;
	blockList?: string[];
}

interface PlanState {
	providerId: string | undefined;
	modelId: string | undefined;
	thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
}

const DEFAULT_CONFIG: PlanModeConfig = {
	provider: "opencode-go",
	model: "qwen3.7-max",
	thinkingLevel: "high",
	planFile: "PLAN.md",
	blockList: ["edit", "write"],
	instructions:
		"You are a meticulous implementation planner.\n" +
		"If needed, use tools and subagents purely to explore the codebase and gather information first.\n" +
		"Once you have gathered all necessary context, output a numbered step-by-step implementation plan to solve the request containing:\n" +
		"1. The specific file(s) to create or modify at each step.\n" +
		"2. What change to make and why.\n" +
		"3. Any prerequisite steps (migrations, installs, config changes).\n" +
		'4. A short "Definition of Done" for the whole task.\n\n' +
		"Keep each step atomic and independently verifiable.\n" +
		"If applicable, identify all the places that need changes or might break due to these changes and revise your plan based on your findings.\n" +
		"When finished, output the final plan as a markdown file without fluff.",
};

const DEFAULT_INSTRUCTIONS = DEFAULT_CONFIG.instructions!;

export default function planModeExtension(pi: ExtensionAPI) {
	let config: PlanModeConfig = {};
	let planModeActive = false;
	let savedState: PlanState | undefined;

	function loadConfig(ctx: ExtensionContext): PlanModeConfig {
		const globalPath = resolve(getAgentDir(), "plan-mode.json");
		const projectPath = resolve(ctx.cwd, CONFIG_DIR_NAME, "plan-mode.json");

		if (!existsSync(globalPath) && !existsSync(projectPath)) {
			try {
				mkdirSync(getAgentDir(), { recursive: true });
				writeFileSync(
					globalPath,
					JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n",
					"utf8",
				);
				console.error(`plan-mode: wrote default config to ${globalPath}`);
			} catch (err) {
				console.error(
					`plan-mode: failed to write default config to ${globalPath}: ${err}`,
				);
			}
		}

		const merged: PlanModeConfig = { ...DEFAULT_CONFIG };

		for (const path of [globalPath, projectPath]) {
			if (!existsSync(path)) continue;
			try {
				const parsed = JSON.parse(readFileSync(path, "utf8"));
				if (parsed.provider) merged.provider = parsed.provider;
				if (parsed.model) merged.model = parsed.model;
				if (parsed.thinkingLevel) merged.thinkingLevel = parsed.thinkingLevel;
				if (parsed.planFile) merged.planFile = parsed.planFile;
				if (parsed.instructions) merged.instructions = parsed.instructions;
				if (parsed.blockList) merged.blockList = parsed.blockList;
			} catch (err) {
				console.error(`plan-mode: failed to parse ${path}: ${err}`);
				ctx.ui.notify(
					`plan-mode: Failed to parse configuration at ${path}.`,
					"warning",
				);
			}
		}
		return merged;
	}

	async function enablePlanMode(ctx: ExtensionContext): Promise<void> {
		if (planModeActive) {
			ctx.ui.notify("Already in plan mode", "info");
			return;
		}

		if (!savedState) {
			savedState = {
				providerId: ctx.model?.provider.id,
				modelId: ctx.model?.id,
				thinkingLevel: pi.getThinkingLevel(),
			};
		}

		if (config.provider && config.model) {
			const model = ctx.modelRegistry.find(config.provider, config.model);
			if (!model) {
				ctx.ui.notify(
					`plan-mode: model ${config.provider}/${config.model} not found in registry. Aborting.`,
					"error",
				);
				return;
			}

			const ok = await pi.setModel(model);
			if (!ok) {
				ctx.ui.notify(
					`plan-mode: no API key for ${config.provider}/${config.model}. Aborting.`,
					"error",
				);
				return;
			}
		} else {
			ctx.ui.notify(
				"plan-mode: no model configured, keeping current model",
				"warning",
			);
		}

		if (config.thinkingLevel) {
			pi.setThinkingLevel(config.thinkingLevel);
		}

		planModeActive = true;
		ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", "plan mode"));

		pi.appendEntry("plan-mode-state", { active: true, savedState });

		const currentBlockList = config.blockList ?? [];
		const blockMsg =
			currentBlockList.length > 0
				? ` [Blocked: ${currentBlockList.join(", ")}]`
				: " [All tools allowed]";
		ctx.ui.notify(`Plan mode enabled${blockMsg}`, "info");
	}

	async function disablePlanMode(ctx: ExtensionContext): Promise<void> {
		if (!planModeActive) {
			ctx.ui.notify("Not in plan mode", "info");
			return;
		}

		if (savedState) {
			if (savedState.providerId && savedState.modelId) {
				const model = ctx.modelRegistry.find(
					savedState.providerId,
					savedState.modelId,
				);
				if (model) {
					await pi.setModel(model);
				}
			}
			pi.setThinkingLevel(savedState.thinkingLevel);
		}

		planModeActive = false;
		savedState = undefined;
		ctx.ui.setStatus("plan-mode", undefined);

		pi.appendEntry("plan-mode-state", { active: false, savedState: undefined });

		ctx.ui.notify("Plan mode disabled", "info");
	}

	function getLastAssistantText(ctx: ExtensionContext): string | undefined {
		// Replicates AgentSession.getLastAssistantText(): a session entry wraps
		// the AgentMessage in { type: "message", message: AgentMessage, ... }.
		// Walk entries newest-first and concatenate the text content blocks.
		const lastAssistant = ctx.sessionManager.getEntries().findLast((e) => {
			if (e.type !== "message") return false;
			const msg = (
				e as {
					message?: { role?: string; stopReason?: string; content?: unknown[] };
				}
			).message;
			if (msg?.role !== "assistant") return false;
			// Skip aborted empty messages (matches AgentSession behaviour).
			if (msg.stopReason === "aborted" && (msg.content?.length ?? 0) === 0)
				return false;
			return true;
		});
		if (!lastAssistant) return undefined;
		const content = (
			lastAssistant as {
				message: { content: { type: string; text?: string }[] };
			}
		).message.content;
		let text = "";
		for (const block of content) {
			if (block.type === "text" && typeof block.text === "string")
				text += block.text;
		}
		text = text.trim();
		return text || undefined;
	}

	async function handleWritePlan(args: unknown, ctx: ExtensionContext) {
		const file =
			typeof args === "string" && args.trim() ? args.trim() : "PLAN.md";
		const filePath = resolve(ctx.cwd, file);

		const text = getLastAssistantText(ctx);
		if (!text) {
			ctx.ui.notify("No assistant message found to save.", "error");
			return;
		}

		if (existsSync(filePath)) {
			if (!ctx.hasUI) {
				ctx.ui.notify(
					`${file} already exists. Run interactively to choose overwrite/append/clear/delete.`,
					"warning",
				);
				return;
			}
			const choice = await ctx.ui.select(
				`${file} already exists. What do you want to do?`,
				["write", "append", "clear", "delete"],
			);
			if (!choice) return; // user cancelled

			try {
				switch (choice) {
					case "write":
						writeFileSync(filePath, text, "utf8");
						ctx.ui.notify(`Wrote plan to ${file}`, "success");
						break;
					case "append":
						appendFileSync(
							filePath,
							(existsSync(filePath) ? "\n\n" : "") + text,
							"utf8",
						);
						ctx.ui.notify(`Appended plan to ${file}`, "success");
						break;
					case "clear":
						writeFileSync(filePath, "", "utf8");
						ctx.ui.notify(`Cleared ${file}`, "success");
						break;
					case "delete":
						unlinkSync(filePath);
						ctx.ui.notify(`Deleted ${file}`, "success");
						break;
				}
			} catch (err) {
				ctx.ui.notify(`Failed to ${choice} ${file}: ${err}`, "error");
			}
			return;
		}

		try {
			writeFileSync(filePath, text, "utf8");
			ctx.ui.notify(`Wrote plan to ${file}`, "success");
		} catch (err) {
			ctx.ui.notify(`Failed to write ${file}: ${err}`, "error");
		}
	}

	pi.registerCommand("plan", {
		description: "Enter plan mode",
		handler: async (_args, ctx) => {
			await enablePlanMode(ctx);
		},
	});

	pi.registerCommand("endplan", {
		description: "Exit plan mode and restore previous model/tools",
		handler: async (_args, ctx) => {
			await disablePlanMode(ctx);
		},
	});

	pi.registerCommand("writeplan", {
		description:
			"Write the last assistant response to PLAN.md (or a specified file)",
		handler: async (args, ctx) => {
			await handleWritePlan(args, ctx);
		},
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (!planModeActive) return;

		return {
			systemPrompt: `${event.systemPrompt}\n\n${config.instructions ?? DEFAULT_INSTRUCTIONS}`,
		};
	});

	pi.on("tool_call", (event, ctx) => {
		if (!planModeActive) return;

		const currentBlockList = config.blockList ?? [];

		if (currentBlockList.includes(event.toolName)) {
			return {
				block: true,
				reason: `plan mode: ${event.toolName} is disallowed — work from the context provided and produce the plan as your text response`,
			};
		}
	});

	pi.on("session_shutdown", (_event, _ctx) => {
		planModeActive = false;
		savedState = undefined;
	});

	pi.on("session_start", async (event, ctx) => {
		config = loadConfig(ctx);

		if (event.reason === "reload") return;

		const entries = ctx.sessionManager.getEntries();

		const lastStateEntry = entries.findLast(
			(e) =>
				e.type === "custom" &&
				(e as { customType?: string }).customType === "plan-mode-state",
		);

		if (lastStateEntry) {
			const entryData = (
				lastStateEntry as {
					data?: { active?: boolean; savedState?: PlanState };
				}
			).data;
			if (entryData?.active) {
				savedState = entryData.savedState;
				await enablePlanMode(ctx);
			}
		}
	});
}
