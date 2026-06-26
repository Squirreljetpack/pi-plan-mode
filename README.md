# Plan Mode

A pi extension that adds `/plan` and `/endplan` commands for structured, read-only planning sessions before implementation.

## What it does

Plan mode lets you pause coding to think. When you enter plan mode:

- **Model switching** — switches to a dedicated planning model (e.g. Opus, Gemini Pro, DeepSeek) that excels at reasoning and architecture.
- **Tool lockdown** — disables `write`, `edit`, and `bash` tools. The model is read-only: it works from the context you've built up and produces a plan as its text response.
- **Instructions injection** — appends plan-mode instructions to the system prompt, guiding the model to investigate the codebase, ask clarifying questions, and produce a concrete, numbered implementation plan.

When you're ready to implement, `/endplan` restores your original model, thinking level, and tool set — you pick up exactly where you left off.

## Installation

```bash
pi install git:github.com/USER/pi-plan-mode
```

Replace `USER` with the GitHub username or organization hosting this repo.

## Configuration

Create a `plan-mode.json` file. Project-local (`.pi/plan-mode.json`) takes precedence over global (`~/.pi/agent/plan-mode.json`).

```json
{
  "provider": "anthropic",
  "model": "claude-opus-4-7",
  "thinkingLevel": "high",
  "planFile": "PLAN.md",
  "instructions": "You are in PLAN MODE. Do not implement. Ask clarifying questions, then produce a numbered step-by-step plan."
}
```

### Options

| Key | Required | Default | Description |
|-----|----------|---------|-------------|
| `provider` | yes (for model switch) | — | Provider ID from the model registry (e.g. `"anthropic"`, `"opencode-go"`, `"gemini"`) |
| `model` | yes (for model switch) | — | Model ID within that provider (e.g. `"claude-opus-4-7"`, `"qwen3.7-plus"`, `"gemini-3-pro"`) |
| `thinkingLevel` | no | current level | Thinking level during plan mode: `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"` |
| `planFile` | no | `"PLAN.md"` | Where the plan will be written (informational — the plan is produced as the model's text response) |
| `instructions` | no | built-in default | Custom instructions injected into the system prompt during plan mode |

If `provider` and `model` are omitted, plan mode keeps your current model but still locks tools and injects planning instructions.

### Example: plan with a reasoning model

```json
{
  "provider": "opencode-go",
  "model": "qwen3.7-plus",
  "thinkingLevel": "high"
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

### Example: plan with Opus, custom instructions

```json
{
  "provider": "anthropic",
  "model": "claude-opus-4-7",
  "thinkingLevel": "xhigh",
  "instructions": "You are in PLAN MODE. First list key files and their purposes. Then outline the architecture. Finally produce a numbered implementation plan with estimated complexity per step."
}
```

## Usage

```
/plan         Enter plan mode
/endplan      Exit plan mode
```

1. Do your research, file reads, exploration with your normal coding model.
2. Type `/plan` — pi switches to your planning model, disables write/edit/bash tools, and injects plan instructions.
3. Send your prompt. The model receives the full conversation context and produces a plan.
4. Type `/endplan` — pi restores your original model, thinking level, and tools.
5. Start implementing the plan.

Plan-mode state persists across `/reload` — if you reload while in plan mode, you stay in plan mode.

## How it works

**Model switching** (`pi.setModel`) — swaps the active model to the configured planning model. The original model (and its API key/connection state) is saved and restored on `/endplan`.

**Tool lockdown** (`pi.setActiveTools([])`) — clears all active tools so the LLM cannot call `write`, `edit`, or `bash`. Additionally, `tool_call` event handlers block these tools outright as a defense-in-depth measure.

**System prompt injection** (`before_agent_start` event) — appends plan-mode instructions to the system prompt. The default instruction tells the model it is in plan mode, to use read-only tools for investigation, to ask clarifying questions, and to produce a numbered step-by-step plan without starting implementation. Override with the `instructions` config field.

**Planning model selection** — choose any model in your pi model registry. The key is picking a model that reasons well about architecture and breaks down problems systematically.

## License

MIT
