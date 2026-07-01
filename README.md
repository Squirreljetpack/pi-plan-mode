# Plan Mode

A pi extension that adds `/plan` and `/endplan` commands for structured, read-only planning sessions before implementation.

## What it does

Plan mode lets you pause coding to think. When you enter plan mode:

- **Model switching** — switches to a dedicated planning model (`opencode-go/qwen3.7-plus` by default) that excels at reasoning and architecture.
- **Tool lockdown** — disables `write`, `edit`, and `bash` tools. The model is read-only: it works from the context you've built up and produces a plan as its text response.
- **Instructions injection** — appends plan-mode instructions to the system prompt, guiding the model to produce a numbered implementation plan with file-level specificity and a definition of done.

When you're ready to implement, `/endplan` restores your original model, thinking level, and tool set — you pick up exactly where you left off.

## Summarization

In addition to plan mode, the extension ships a `/summarize` command:

- **`/summarize`** — runs the configured summarizer (`summarizerProvider` +
  `summarizerModel`, or the current model) over the conversation using
  `summarizerPrompt`, then writes the result to
  `summarizeDir/<YYYY-MM-DD>-<sessionId8>.md`.

```json
{
  "summarizerProvider": "opencode-go",
  "summarizerModel": "qwen3.7-max",
  "summarizerPrompt": "Summarize the conversation in 3 short bullets.",
  "summarizeDir": "~/.pi/agent/summaries"
}
```

If `summarizerProvider` / `summarizerModel` are omitted, the summarizer
falls back to whatever model is currently active in pi.

`summarizeDir` accepts a leading `~` for the user's home directory
(e.g. `"~/my-summaries"`).

See [`examples/plan-mode.example.json`](examples/plan-mode.example.json)
for a full config with every field at its default, plus a `minimax-m3`
summarizer.

## Installation

```bash
pi install git:github.com/Squirreljetpack/pi-plan-mode
```

## Configuration

**Zero-config by default.** On first load, the extension writes `~/.pi/agent/plan-mode.json` with sensible defaults. You only need to create a config file if you want to change the model or instructions.

Project-local config (`.pi/plan-mode.json`) takes precedence over global (`~/.pi/agent/plan-mode.json`). Configuration loading merges both files — you can set only the fields you want to override.

### Default config

```json
{
  "provider": "opencode-go",
  "model": "qwen3.7-plus",
  "thinkingLevel": "high",
  "planFile": "PLAN.md",
  "instructions": "You are a pragmatic implementation planner.\nYou receive: a user request, a summary of the current codebase (provided by the main agent), and any relevant findings from the Analyst.\n\nYour output is a numbered step-by-step implementation plan with:\n1. The specific file(s) to create or modify at each step.\n2. What change to make and why.\n3. Any prerequisite steps (migrations, installs, config changes).\n4. A short \"Definition of Done\" for the whole task.\n\nKeep each step atomic and independently verifiable.\nDo not write code. Do not use tools. Work only with the context provided."
}
```

### Options

| Key | Default | Description |
|-----|---------|-------------|
| `provider` | `"opencode-go"` | Provider ID from the model registry (e.g. `"anthropic"`, `"gemini"`, `"opencode-go"`) |
| `model` | `"qwen3.7-plus"` | Model ID within that provider (e.g. `"claude-opus-4-7"`, `"gemini-3-pro"`) |
| `thinkingLevel` | `"high"` | Thinking level during plan mode: `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"` |
| `planFile` | `"PLAN.md"` | Where the plan will be written (informational — the plan is produced as the model's text response) |
| `instructions` | (see above) | Custom instructions injected into the system prompt during plan mode |
| `blockList` | `["edit", "write"]` | Tool names blocked outright while plan mode is active (defense-in-depth) |
| `summarizerProvider` | (current model) | Provider used by `/summarize` |
| `summarizerModel` | (current model) | Model used by `/summarize` |
| `summarizerPrompt` | (see source) | Prompt sent to the summarizer for `/summarize` |
| `summarizeDir` | unset | Required for `/summarize`; output goes here |

### Example: plan with Opus

```json
{
  "provider": "anthropic",
  "model": "claude-opus-4-7",
  "thinkingLevel": "xhigh"
}
```

### Example: plan with Gemini

```json
{
  "provider": "gemini",
  "model": "gemini-3-pro",
  "thinkingLevel": "high"
}
```

### Example: custom instructions

```json
{
  "instructions": "You are in PLAN MODE. First list key files and their purposes. Then outline the architecture. Finally produce a numbered implementation plan with estimated complexity per step. Do not write code."
}
```

## Usage

```
/plan                    Enter plan mode
/plan write [file]       Save the last assistant message to PLAN.md (or [file]).
/plan set | s            Capture the current model/provider into the plan
                         config (writes to .pi/plan-mode.json if it exists;
                         otherwise prompts for project vs global), then
                         enter plan mode. Inside plan mode, just writes.
/endplan [next_prompt]   Exit plan mode. With [next_prompt]: submit it iff
                         switching out actually changed models; otherwise
                         drop it into the next prompt line.
/summarize               Summarize the conversation to summarizeDir/.
```

1. Do your research, file reads, exploration with your normal coding model.
2. Type `/plan` — pi switches to your planning model, disables write/edit/bash tools, and injects plan instructions.
   - Or `/plan set` to first capture your current model as the plan default. Writes to `.pi/plan-mode.json` if it exists; otherwise prompts for project vs global. Inside plan mode, `/plan set` just writes the current model (useful after switching models mid-plan with `/model`).
3. Send your prompt. The model receives the full conversation context and produces a plan.
4. Type `/plan write` (or `/plan write path/to/plan.md`) to save the plan. If the target file already exists and is non-empty, pi prompts you to overwrite, append, clear, or delete it.
5. Type `/endplan` to exit plan mode, optionally followed by your first implementation prompt (e.g. `/endplan now implement step 1`).
6. Start implementing the plan.

Type `/summarize` at any time to produce a markdown summary of the
current conversation, written to `summarizeDir`.

Plan-mode state persists across `/reload` — if you reload while in plan mode, you stay in plan mode.

## How it works

**Model switching** (`pi.setModel`) — swaps the active model to the configured planning model. The original model (and its API key/connection state) is saved and restored on `/endplan`.

**Tool lockdown** (`pi.setActiveTools([])`) — clears all active tools so the LLM cannot call `write`, `edit`, or `bash`. Additionally, `tool_call` event handlers block these tools outright as a defense-in-depth measure.

**System prompt injection** (`before_agent_start` event) — appends plan-mode instructions to the system prompt. The default instructions guide the model to produce a numbered, file-level implementation plan with a definition of done. Override with the `instructions` config field.

**Auto-config** — on first load, if no config file exists, the extension writes a default `~/.pi/agent/plan-mode.json`. This means plan mode works out of the box with `opencode-go/qwen3.7-plus` at high thinking.

**Capture current model** — `/plan set` writes the currently active model/provider into the plan config, then enters plan mode. If `.pi/plan-mode.json` exists, the update goes there; otherwise the user is prompted to choose between project and global. All other config fields (instructions, blockList, summarizer settings, etc.) are preserved. Inside plan mode, `/plan set` is a write-only operation — it does not re-enter plan mode.

## License

MIT

## Tests

```bash
npm test
```

Runs the test suite (41 tests across 5 files) using Node's built-in
`node:test` runner. The suite:

- Loads the extension via jiti with a mocked `@earendil-works/pi-ai/compat`,
  so it never hits a real LLM.
- Uses a real `SessionManager` against a tmp directory, so the export and
  branch traversal logic is exercised end-to-end.
- Runs each test in an isolated `HOME` + `cwd`, with concurrency = 1 (some
  tests mutate `process.env.HOME` and `globalThis`).
- Resolves `pi-coding-agent` by looking beside the running `node` binary
  (same trick as `bin/export-session.mjs`), so no symlinks need to be set
  up by hand. `pretest` symlinks the package into the project's
  `node_modules/` if it isn't there already.

Files:

- `tests/_setup.mjs` — symlink farm
- `tests/_helpers.mjs` — `TestEnv` class (tmp HOME/cwd, real SessionManager, mock complete, captured hooks)
- `tests/config.test.mjs` — default config creation, global vs project merging, malformed config
- `tests/plan-mode.test.mjs` — `/plan`, `/endplan` (incl. `next_prompt`), model switching, tool blocking, instructions injection, state persistence across reload
- `tests/summarize.test.mjs` — `/summarize`, summarizer prompt forwarding, model fallback
- `tests/tilde.test.mjs` — `~` expansion in directory fields
- `tests/writeplan.test.mjs` — `/plan write [file]` (formerly `/writeplan`), conflict prompt, headless mode, error paths
