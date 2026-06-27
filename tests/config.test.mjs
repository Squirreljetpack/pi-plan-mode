/**
 * Tests for config loading: default config creation, global vs project
 * merging, and config validation errors.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TestEnv } from "./_helpers.mjs";

describe("config loading", () => {
	test("writes a default config to the global location on first run", async () => {
		const env = new TestEnv();
		try {
			await env.loadExtension();
			const ctx = env.buildCtx();
			await env.events.session_start({ reason: "start" }, ctx);

			const globalPath = join(env.tmpHome, ".pi", "agent", "plan-mode.json");
			assert.ok(
				existsSync(globalPath),
				`default config was created at ${globalPath}`,
			);
			const config = JSON.parse(readFileSync(globalPath, "utf8"));
			assert.equal(config.provider, "opencode-go");
			assert.equal(config.model, "qwen3.7-max");
			assert.equal(config.thinkingLevel, "high");
			assert.equal(config.planFile, "PLAN.md");
			assert.deepEqual(config.blockList, ["edit", "write"]);
		} finally {
			env.cleanup();
		}
	});

	test("uses the default config when no project config exists", async () => {
		const env = new TestEnv();
		try {
			await env.loadExtension();
			const ctx = env.buildCtx({
				provider: "opencode-go",
				modelId: "qwen3.7-max",
			});
			await env.events.session_start({ reason: "start" }, ctx);

			await env.commands.plan.handler("", ctx);
			assert.equal(env.setModelResults[0].id, "qwen3.7-max");
		} finally {
			env.cleanup();
		}
	});

	test("overrides the default when a project config exists", async () => {
		const env = new TestEnv();
		try {
			await env.loadExtension();
			env.writeConfig({
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				thinkingLevel: "xhigh",
			});
			const ctx = env.buildCtx({
				provider: "anthropic",
				modelId: "claude-sonnet-4-5",
			});
			await env.events.session_start({ reason: "start" }, ctx);

			await env.commands.plan.handler("", ctx);
			assert.equal(env.setModelResults[0].id, "claude-sonnet-4-5");
			assert.equal(
				env.thinkingLevelCalls[env.thinkingLevelCalls.length - 1],
				"xhigh",
			);
		} finally {
			env.cleanup();
		}
	});

	test("warns and continues when a config file is malformed", async () => {
		const env = new TestEnv();
		try {
			await env.loadExtension();
			writeFileSync(
				join(env.tmpDir, ".pi", "plan-mode.json"),
				"{ not valid json",
			);
			const ctx = env.buildCtx({
				provider: "opencode-go",
				modelId: "qwen3.7-max",
			});
			await env.events.session_start({ reason: "start" }, ctx);

			await env.commands.plan.handler("", ctx);
			assert.equal(env.setModelResults[0].id, "qwen3.7-max");

			assert.ok(
				env.notifications.some(
					(n) =>
						n.type === "warning" &&
						/failed to parse configuration/i.test(n.message),
				),
			);
		} finally {
			env.cleanup();
		}
	});

	test("commands register even if no config is provided", async () => {
		const env = new TestEnv();
		try {
			await env.loadExtension();
			for (const name of ["plan", "endplan", "writeplan", "summarize"]) {
				assert.ok(
					env.commands[name],
					`command ${name} is registered at load time`,
				);
			}
		} finally {
			env.cleanup();
		}
	});
});
