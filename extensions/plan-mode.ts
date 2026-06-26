/**
 * Plan Mode Extension
 *
 * Adds /plan and /endplan commands.
 *
 * - /plan   switches to a configurable "plan model", disables all tools (the
 *           plan model is read-only and produces its output as text), and
 *           appends a short system-prompt instruction telling the model to
 *           produce a numbered implementation plan from the context it is
 *           given.
 * - /endplan restores the previous model, thinking level, and tool set.
 *
 * While plan mode is active, the extension blocks write, edit, and bash tool
 * calls outright as a defensive guard.
 *
 * Configuration (~/.pi/agent/plan-mode.json or .pi/plan-mode.json):
 *   {
 *     "provider": "opencode-go",          // provider id from the model registry
 *     "model": "qwen3.7-plus",            // model id within that provider
 *     "thinkingLevel": "high",            // optional: off|minimal|low|medium|high|xhigh
 *     "planFile": "PLAN.md",              // optional, default "PLAN.md" (informational)
 *     "instructions": "..."               // optional, replaces the default instructions
 *   }
 *
 * Project-local config takes precedence over the global one.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

interface PlanModeConfig {
	/** Provider id (e.g. "anthropic"). Omit to keep the current provider. */
	provider?: string;
	/** Model id within the provider (e.g. "claude-opus-4-7"). */
	model?: string;
	/** Thinking level to use in plan mode. */
	thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	/** File the plan is written to. Default: "PLAN.md". */
	planFile?: string;
	/** Replaces the default plan-mode instructions when set. */
	instructions?: string;
}

interface PlanState {
	model: Model<Api> | undefined;
	thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	tools: string[];
}

const DEFAULT_PLAN_FILE = "PLAN.md";
const DEFAULT_INSTRUCTIONS =
	"You are in PLAN MODE. Do not modify any code or files. " +
	"Investigate the codebase with read-only tools, ask clarifying questions when " +
	"requirements are ambiguous, and produce a concrete, step-by-step implementation " +
	"plan in your text response. Do not start implementing.";

export default function planModeExtension(pi: ExtensionAPI) {
	let config: PlanModeConfig = {};
	let active = false;
	let savedState: PlanState | undefined;

	function loadConfig(cwd: string): PlanModeConfig {
		const globalPath = resolve(getAgentDir(), "plan-mode.json");
		const projectPath = resolve(cwd, CONFIG_DIR_NAME, "plan-mode.json");

		const merged: PlanModeConfig = {};
		for (const path of [globalPath, projectPath]) {
			if (!existsSync(path)) continue;
			try {
				Object.assign(merged, JSON.parse(readFileSync(path, "utf8")));
			} catch (err) {
				console.error(`plan-mode: failed to parse ${path}: ${err}`);
			}
		}
		return merged;
	}

	function getPlanFile(): string {
		return config.planFile ?? DEFAULT_PLAN_FILE;
	}

	async function enablePlanMode(ctx: ExtensionContext): Promise<void> {
		if (active) {
			ctx.ui.notify("Already in plan mode", "info");
			return;
		}

		// Snapshot current state so /endplan can restore it.
		savedState = {
			model: ctx.model,
			thinkingLevel: pi.getThinkingLevel(),
			tools: pi.getActiveTools(),
		};

		// Switch model if configured.
		if (config.provider && config.model) {
			const model = ctx.modelRegistry.find(config.provider, config.model);
			if (!model) {
				ctx.ui.notify(
					`plan-mode: model ${config.provider}/${config.model} not found in registry`,
					"warning",
				);
			} else {
				const ok = await pi.setModel(model);
				if (!ok) {
					ctx.ui.notify(
						`plan-mode: no API key for ${config.provider}/${config.model}`,
						"warning",
					);
				}
			}
		} else {
			ctx.ui.notify(
				"plan-mode: no model configured, keeping current model (set provider + model in plan-mode.json)",
				"warning",
			);
		}

		// Set thinking level.
		if (config.thinkingLevel) {
			pi.setThinkingLevel(config.thinkingLevel);
		}

		// Disable tools the plan model is not allowed to use. The plan model
		// is read-only: it works from the context the main agent passes in
		// and produces a plan as its text response, never mutates state.
		pi.setActiveTools([]);

		active = true;
		ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", "plan mode"));
		ctx.ui.notify(`Plan mode enabled — writing to ${getPlanFile()}`, "info");
	}

	async function disablePlanMode(ctx: ExtensionContext): Promise<void> {
		if (!active) {
			ctx.ui.notify("Not in plan mode", "info");
			return;
		}

		if (savedState) {
			if (savedState.model) {
				await pi.setModel(savedState.model);
			}
			pi.setThinkingLevel(savedState.thinkingLevel);
			if (savedState.tools.length > 0) {
				pi.setActiveTools(savedState.tools);
			}
		}

		active = false;
		savedState = undefined;
		ctx.ui.setStatus("plan-mode", undefined);
		ctx.ui.notify("Plan mode disabled", "info");
	}

	pi.registerCommand("plan", {
		description: "Enter plan mode (read-only plan model, no write/edit/bash)",
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

	// Inject the plan-mode instruction into the system prompt.
	pi.on("before_agent_start", (event) => {
		if (!active) return;
		const instructions = config.instructions ?? DEFAULT_INSTRUCTIONS;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${instructions}`,
		};
	});

	// Block any write/edit/bash call — the plan model is read-only and works
	// only from the context the main agent passes in. The `write` and `edit`
	// tools are blocked outright (we don't write the plan via tools; the plan
	// is produced as the assistant's text output). The `bash` tool is also
	// blocked because shell commands could mutate the repo.
	pi.on("tool_call", (event) => {
		if (!active) return;

		if (event.toolName === "write") {
			return {
				block: true,
				reason: "plan mode: write is disallowed — produce the plan as your text response",
			};
		}

		if (event.toolName === "edit") {
			return {
				block: true,
				reason: "plan mode: edit is disallowed — produce the plan as your text response",
			};
		}

		if (event.toolName === "bash") {
			return {
				block: true,
				reason: "plan mode: bash is disallowed — work from the context provided",
			};
		}
	});

	// Clean up on session shutdown.
	pi.on("session_shutdown", () => {
		active = false;
		savedState = undefined;
	});

	// Load config on session start and restore plan mode if the previous
	// session was still in it.
	pi.on("session_start", async (event, ctx) => {
		config = loadConfig(ctx.cwd);

		if (event.reason === "reload") return;

		const lastEntry = ctx.sessionManager.getEntries().at(-1);
		if (
			lastEntry &&
			lastEntry.type === "custom" &&
			(lastEntry as { customType?: string }).customType === "plan-mode-state" &&
			(lastEntry as { data?: { active?: boolean } }).data?.active
		) {
			await enablePlanMode(ctx);
		}
	});

	// Persist plan-mode state so a /reload keeps the user in plan mode.
	pi.on("turn_start", () => {
		if (active) {
			pi.appendEntry("plan-mode-state", { active: true });
		}
	});
}
