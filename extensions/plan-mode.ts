/**
 * Plan Mode Extension
 *
 * - /plan               switch to the configured plan model, block listed
 *                       tools, and inject planning instructions.
 * - /plan write [file]  save the last assistant message to PLAN.md (or [file]).
 * - /plan set           capture the current model/provider into the plan
 *                       config (project if it exists, else prompted for
 *                       project vs global), then enter plan mode.
 * - /endplan [prompt]   restore the previous model/thinking level. If [prompt]
 *                       is given and exiting actually changes the model,
 *                       submit it; otherwise drop it into the editor.
 * - /summarize          summarize the conversation to summarizeDir/.
 */

import type { Model } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

interface PlanModeConfig {
  provider?: string;
  model?: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  planFile?: string; // Kept in config schema as requested
  instructions?: string;
  blockList?: string[];
  /** Provider id for the summarizer. Defaults to the current model. */
  summarizerProvider?: string;
  /** Model id for the summarizer. Defaults to the current model. */
  summarizerModel?: string;
  /** Prompt sent to the summarizer for the /summarize command. */
  summarizerPrompt?: string;
  /** Directory where /summarize writes its output. */
  summarizeDir?: string;
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
  instructions: "You are a meticulous implementation planner.\nIf needed, use tools and subagents purely to explore the codebase and gather information first.\nOnce you have gathered all necessary context, make a step-by-step implementation plan to solve the request containing:\n1. The specific file(s) to create or modify at each step.\n2. What change to make.\n3. Optional notes such as any prerequisite steps (migrations, installs, config changes), reasons for the change or a definition of done (for complex changes).\nKeep each step atomic, and descriptions short!\nIMPORTANT: If applicable, identify all the places that need changes or might break due to these changes and revise your plan based on your findings.\nWhen finished, reply with the final plan in markdown format without fluff. While we are still working out the details of the initial plan, do not regenerate the full plan.",
};

const DEFAULT_INSTRUCTIONS = DEFAULT_CONFIG.instructions!;

const DEFAULT_SUMMARIZER_PROMPT = "Summarize this conversation in clear, structured markdown. Include: "
  + "(1) overall achievements, decisions and tradeoffs made, and (2) interesting questions/answers/discoveries."
  + "Prefer to be concise but include details when details are the point.";

export default function planModeExtension(pi: ExtensionAPI) {
  let config: PlanModeConfig = {};
  let planModeActive = false;
  let savedState: PlanState | undefined;

  /** Expand a leading "~" or "~/" to the user's home directory. */
  function expandHome(p: string): string {
    if (p === "~") return homedir();
    if (p.startsWith("~/") || p.startsWith("~\\")) {
      return homedir() + p.slice(1);
    }
    return p;
  }

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
        if (parsed.summarizerProvider) {
          merged.summarizerProvider = parsed.summarizerProvider;
        }
        if (parsed.summarizerModel) {
          merged.summarizerModel = parsed.summarizerModel;
        }
        if (parsed.summarizerPrompt) {
          merged.summarizerPrompt = parsed.summarizerPrompt;
        }
        if (parsed.summarizeDir) merged.summarizeDir = parsed.summarizeDir;
      } catch (err) {
        console.error(`plan-mode: failed to parse ${path}: ${err}`);
        ctx.ui.notify(
          `plan-mode: Failed to parse configuration at ${path}.`,
          "warning",
        );
      }
    }
    // Expand leading "~" / "~/" in summarizeDir so users can write
    // "~/my-summaries" in their config and have it resolve correctly
    // across platforms. `path.resolve` does not do this for us.
    if (merged.summarizeDir) {
      merged.summarizeDir = expandHome(merged.summarizeDir);
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
    const blockMsg = currentBlockList.length > 0
      ? ` [Blocked: ${currentBlockList.join(", ")}]`
      : " [All tools allowed]";
    ctx.ui.notify(`Plan mode enabled${blockMsg}`, "info");
  }

  async function disablePlanMode(
    ctx: ExtensionContext,
    nextPrompt?: string,
  ): Promise<void> {
    if (!planModeActive) {
      ctx.ui.notify("Not in plan mode", "info");
      return;
    }

    // Was the active model switched to the plan model on entry? If so,
    // switching back is a real model change and we can safely send a
    // follow-up prompt straight to the restored model. Otherwise the
    // active model is still the planning model — submitting would fire
    // an implementation prompt at a model that was set up for planning,
    // so we only stage the text in the editor.
    const modelWillChange = !!savedState?.providerId
      && !!savedState.modelId
      && (ctx.model?.provider.id !== savedState.providerId
        || ctx.model?.id !== savedState.modelId);

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

    const trimmedPrompt = nextPrompt?.trim();
    if (trimmedPrompt) {
      if (modelWillChange) {
        pi.sendUserMessage(trimmedPrompt);
      } else if (ctx.hasUI) {
        ctx.ui.setEditorText(trimmedPrompt);
      }
    }
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
      if (msg.stopReason === "aborted" && (msg.content?.length ?? 0) === 0) {
        return false;
      }
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
      if (block.type === "text" && typeof block.text === "string") {
        text += block.text;
      }
    }
    text = text.trim();
    return text || undefined;
  }

  async function handleWritePlan(args: unknown, ctx: ExtensionContext) {
    const file = typeof args === "string" && args.trim() ? args.trim() : "PLAN.md";
    const filePath = resolve(ctx.cwd, file);

    const text = getLastAssistantText(ctx);
    if (!text) {
      ctx.ui.notify("No assistant message found to save.", "error");
      return;
    }

    if (existsSync(filePath) && statSync(filePath).size > 0) {
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

  // =========================================================================
  // Summarization helpers (/summarize)
  // =========================================================================

  /** Concatenate text from a message content field (string or content[]). */
  function extractText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    let s = "";
    for (const block of content) {
      if (
        block
        && typeof block === "object"
        && (block as { type?: string }).type === "text"
        && typeof (block as { text?: unknown }).text === "string"
      ) {
        s += (block as { text: string }).text;
      }
    }
    return s;
  }

  /** Build a plain-text version of the conversation for the summarizer. */
  function buildConversationText(entries: SessionEntry[]): string {
    const sections: string[] = [];
    for (const e of entries) {
      if (e.type !== "message") continue;
      const msg = (
        e as {
          message?: { role?: string; content?: unknown; stopReason?: string };
        }
      ).message;
      if (!msg?.role) continue;
      if (msg.role !== "user" && msg.role !== "assistant") continue;
      if (msg.role === "assistant" && msg.stopReason === "aborted") continue;
      const text = extractText(msg.content).trim();
      if (text) {
        sections.push(`${msg.role === "user" ? "User" : "Assistant"}: ${text}`);
      }
    }
    return sections.join("\n\n");
  }

  /** Make a string safe to use as part of a filename. */
  function sanitizeFilename(s: string): string {
    const cleaned = s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
    return cleaned || "untitled";
  }

  /** YYYY-MM-DD in local time. */
  function dateStamp(d = new Date()): string {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  /** Resolve the model to use for summarization, falling back to ctx.model. */
  function resolveSummarizerModel(ctx: ExtensionContext): {
    model: Model<any> | undefined;
    provider?: string;
    id?: string;
  } {
    const cfgProvider = config.summarizerProvider;
    const cfgModel = config.summarizerModel;
    if (cfgProvider && cfgModel) {
      return {
        model: ctx.modelRegistry.find(cfgProvider, cfgModel),
        provider: cfgProvider,
        id: cfgModel,
      };
    }
    if (cfgModel) {
      // try to find by id across known providers
      for (const m of ctx.modelRegistry.getAll()) {
        if (m.id === cfgModel) {
          return { model: m, provider: m.provider, id: m.id };
        }
      }
    }
    if (ctx.model) {
      return {
        model: ctx.model,
        provider: ctx.model.provider,
        id: ctx.model.id,
      };
    }
    return { model: undefined };
  }

  /**
   * Run a single user prompt against the summarizer model and return the
   * response text. Returns undefined on auth/lookup failure or no model.
   */
  async function callSummarizer(
    userPrompt: string,
    ctx: ExtensionContext,
    systemPrompt?: string,
  ): Promise<string | undefined> {
    const { model } = resolveSummarizerModel(ctx);
    if (!model) {
      ctx.ui.notify(
        "summarizer: no model available (no current model and none configured)",
        "error",
      );
      return undefined;
    }
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      ctx.ui.notify(`summarizer: ${auth.error}`, "error");
      return undefined;
    }
    if (!auth.apiKey) {
      ctx.ui.notify(
        `summarizer: no API key for ${model.provider}/${model.id}`,
        "error",
      );
      return undefined;
    }
    const messages = [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: userPrompt }],
        timestamp: Date.now(),
      },
    ];
    try {
      const response = await complete(
        model,
        {
          ...(systemPrompt ? { systemPrompt } : {}),
          messages,
        },
        {
          apiKey: auth.apiKey,
          headers: auth.headers,
          reasoningEffort: "low",
        },
      );
      return response.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n")
        .trim();
    } catch (err) {
      ctx.ui.notify(
        `summarizer: call failed — ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
      return undefined;
    }
  }

  async function writeMarkdown(
    dir: string,
    file: string,
    body: string,
    ctx: ExtensionContext,
  ) {
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const filePath = resolve(dir, file);
      writeFileSync(filePath, body, "utf8");
      ctx.ui.notify(`Wrote ${filePath}`, "success");
      return filePath;
    } catch (err) {
      ctx.ui.notify(`Failed to write ${file}: ${err}`, "error");
      return undefined;
    }
  }

  // =========================================================================
  // /plan set — capture the current model/provider into the plan config
  // =========================================================================

  /** Resolve the project and global plan-mode.json paths. */
  function configPaths(ctx: ExtensionContext): { project: string; global: string } {
    return {
      project: resolve(ctx.cwd, CONFIG_DIR_NAME, "plan-mode.json"),
      global: resolve(getAgentDir(), "plan-mode.json"),
    };
  }

  /**
   * Capture the current `ctx.model` into the plan config. If a project
   * config already exists, write there; otherwise prompt the user to
   * choose between project and global (headless mode refuses and asks
   * the user to run interactively). All other fields in the target
   * config are preserved. Outside plan mode, also enters plan mode
   * after the write; inside plan mode, the write is the only effect.
   */
  async function handleSetPlanModel(ctx: ExtensionContext): Promise<void> {
    if (!ctx.model) {
      ctx.ui.notify("plan-mode: no current model to save as default", "error");
      return;
    }

    const provider = ctx.model.provider.id;
    const model = ctx.model.id;
    const paths = configPaths(ctx);

    let targetPath: string;
    if (existsSync(paths.project)) {
      targetPath = paths.project;
    } else {
      if (!ctx.hasUI) {
        ctx.ui.notify(
          "plan-mode: no project config exists. Run interactively to choose where to save the plan model.",
          "warning",
        );
        return;
      }
      const choice = await ctx.ui.select(
        "No project plan-mode config. Where should the plan model be saved?",
        [
          `Project (${paths.project})`,
          `Global (${paths.global})`,
        ],
      );
      if (!choice) {
        ctx.ui.notify("plan-mode: set cancelled", "info");
        return;
      }
      if (choice.startsWith("Project")) {
        targetPath = paths.project;
      } else if (choice.startsWith("Global")) {
        targetPath = paths.global;
      } else {
        ctx.ui.notify(
          `plan-mode: unexpected selection: ${choice}`,
          "error",
        );
        return;
      }
    }

    // Read the existing target config (if any) and preserve every field.
    // We only update `provider` and `model`; instructions, blockList,
    // summarizer*, planFile, thinkingLevel, etc. are left untouched.
    let merged: PlanModeConfig = {};
    if (existsSync(targetPath)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(targetPath, "utf8"));
      } catch (err) {
        ctx.ui.notify(
          `plan-mode: config at ${targetPath} is malformed; fix it before /plan set — ${err}`,
          "error",
        );
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        ctx.ui.notify(
          `plan-mode: config at ${targetPath} is not a JSON object; aborting`,
          "error",
        );
        return;
      }
      merged = { ...(parsed as PlanModeConfig) };
    }

    merged.provider = provider;
    merged.model = model;

    try {
      mkdirSync(resolve(targetPath, ".."), { recursive: true });
      writeFileSync(targetPath, JSON.stringify(merged, null, 2) + "\n", "utf8");
    } catch (err) {
      ctx.ui.notify(
        `plan-mode: failed to write config at ${targetPath}: ${err}`,
        "error",
      );
      return;
    }

    // Mirror the on-disk state into the in-memory config so the next
    // enablePlanMode() (if we enter it) uses the new model.
    config.provider = provider;
    config.model = model;

    ctx.ui.notify(
      `plan-mode: default plan model set to ${provider}/${model} (${targetPath})`,
      "success",
    );

    if (planModeActive) return;

    // Outside plan mode: enter plan mode with the new model. The
    // saved state captures the user's current model so /endplan can
    // restore it.
    await enablePlanMode(ctx);
  }

  // =========================================================================
  // /summarize
  // =========================================================================
  async function handleSummarizeCommand(ctx: ExtensionContext) {
    const dir = config.summarizeDir;
    if (!dir) {
      ctx.ui.notify(
        "summarize: set `summarizeDir` in plan-mode.json to use /summarize",
        "error",
      );
      return;
    }
    const entries = ctx.sessionManager.getBranch() as SessionEntry[];
    const text = buildConversationText(entries);
    if (!text) {
      ctx.ui.notify("No conversation to summarize", "warning");
      return;
    }
    const prompt = config.summarizerPrompt ?? DEFAULT_SUMMARIZER_PROMPT;
    const wrapped = `${prompt}\n\n<conversation>\n${text}\n</conversation>`;
    if (ctx.hasUI) ctx.ui.notify("Summarizing conversation…", "info");
    const summary = await callSummarizer(wrapped, ctx);
    if (!summary) return;
    const id = sanitizeFilename(ctx.sessionManager.getSessionId().slice(0, 8));
    const file = `${dateStamp()}-${id}.md`;
    const body = `# Summary — ${dateStamp()}\n\n${summary}\n`;
    await writeMarkdown(dir, file, body, ctx);
  }

  pi.registerCommand("plan", {
    description: "Enter plan mode (or `/plan write [file]`, `/plan set` to capture the current model)",
    handler: async (args, ctx) => {
      const trimmed = args.trim();

      // Matches 'write' or 'w' at the start, followed by either a space or the end of the string
      const writeMatch = trimmed.match(/^(write|w)\b\s*/i);
      if (writeMatch) {
        // match[0] is the entire matched prefix (e.g., "write " or "w ")
        const file = trimmed.substring(writeMatch[0].length).trim();
        await handleWritePlan(file, ctx);
        return;
      }

      // Matches 'set' or 's' at the start, followed by a word boundary.
      // Takes no arguments — anything after the subcommand is ignored.
      const setMatch = trimmed.match(/^(set|s)\b\s*/i);
      if (setMatch) {
        await handleSetPlanModel(ctx);
        return;
      }

      await enablePlanMode(ctx);
    },
  });

  pi.registerCommand("endplan", {
    description: "Exit plan mode and restore previous model/tools (optional next prompt)",
    handler: async (args, ctx) => {
      await disablePlanMode(ctx, args);
    },
  });

  pi.registerCommand("summarize", {
    description: "Summarize the conversation and write to summarizeDir/<date>-<id>.md",
    handler: async (_args, ctx) => {
      await handleSummarizeCommand(ctx);
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
        reason:
          `plan mode: ${event.toolName} is disallowed — work from the context provided and produce the plan as your text response`,
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
        e.type === "custom"
        && (e as { customType?: string }).customType === "plan-mode-state",
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
