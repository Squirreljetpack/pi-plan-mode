# Plan Mode

A pi extension that adds `/plan` and `/endplan` commands for structured, read-only planning sessions before implementation.

## What it does

Plan mode lets you pause coding to think. When you enter plan mode:

- **Model switching** — switches to a dedicated planning model (`opencode-go/qwen3.7-plus` by default) that excels at reasoning and architecture.
- **Tool lockdown** — disables `write`, `edit`, and `bash` tools. The model is read-only: it works from the context you've built up and produces a plan as its text response.
- **Instructions injection** — appends plan-mode instructions to the system prompt, guiding the model to produce a numbered implementation plan with file-level specificity and a definition of done.

When you're ready to implement, `/endplan` restores your original model, thinking level, and tool set — you pick up exactly where you left off.

## Configuration

update: edit vs overwrite (todo)

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
/plan             Enter plan mode
/endplan          Exit plan mode
/writeplan [file] Save the last assistant message to PLAN.md (or [file]).
                  If the file exists, prompts for write / append / clear / delete.
```

1. Do your research, file reads, exploration with your normal coding model.
2. Type `/plan` — pi switches to your planning model, disables write/edit/bash tools, and injects plan instructions.
3. Send your prompt. The model receives the full conversation context and produces a plan.
4. Type `/writeplan` (or `/writeplan path/to/plan.md`) to save the plan. If the target file already exists, pi prompts you to overwrite, append, clear, or delete it.
5. Type `/endplan` — pi restores your original model, thinking level, and tools.
6. Start implementing the plan.

Plan-mode state persists across `/reload` — if you reload while in plan mode, you stay in plan mode.

## How it works

**Model switching** (`pi.setModel`) — swaps the active model to the configured planning model. The original model (and its API key/connection state) is saved and restored on `/endplan`.

**Tool lockdown** (`pi.setActiveTools([])`) — clears all active tools so the LLM cannot call `write`, `edit`, or `bash`. Additionally, `tool_call` event handlers block these tools outright as a defense-in-depth measure.

**System prompt injection** (`before_agent_start` event) — appends plan-mode instructions to the system prompt. The default instructions guide the model to produce a numbered, file-level implementation plan with a definition of done. Override with the `instructions` config field.

**Auto-config** — on first load, if no config file exists, the extension writes a default `~/.pi/agent/plan-mode.json`. This means plan mode works out of the box with `opencode-go/qwen3.7-plus` at high thinking.

## License

MIT
