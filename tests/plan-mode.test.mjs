/**
 * Tests for /plan and /endplan. Verifies model switching, tool blocking,
 * instructions injection, state restoration, idempotency, and state
 * persistence across reloads.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { TestEnv } from "./_helpers.mjs";

async function loadEnvWithPlanModel({
	planProvider = "opencode-go",
	planModel = "plan-model",
	userModel = "user-model",
	thinkingLevel = "medium",
	blockList = ["write", "edit"],
} = {}) {
	const env = new TestEnv();
	await env.loadExtension();
	env.writeConfig({
		provider: planProvider,
		model: planModel,
		thinkingLevel,
		blockList,
	});
	const ctx = env.buildCtx({
		provider: planProvider,
		modelId: userModel,
		models: [
			{ provider: planProvider, id: userModel },
			{ provider: planProvider, id: planModel },
		],
	});
	return { env, ctx };
}

describe("/plan and /endplan", () => {
	test("switches to the configured plan model on /plan", async () => {
		const { env, ctx } = await loadEnvWithPlanModel();
		try {
			await env.events.session_start({ reason: "start" }, ctx);

			assert.equal(
				env.setModelResults.length,
				0,
				"no model switch before /plan",
			);
			await env.commands.plan.handler("", ctx);

			assert.equal(env.setModelResults.length, 1);
			assert.equal(env.setModelResults[0].id, "plan-model");
			assert.equal(env.setModelResults[0].provider.id, "opencode-go");
		} finally {
			env.cleanup();
		}
	});

	test("sets the configured thinking level on /plan", async () => {
		const { env, ctx } = await loadEnvWithPlanModel({ thinkingLevel: "xhigh" });
		try {
			await env.events.session_start({ reason: "start" }, ctx);
			await env.commands.plan.handler("", ctx);
			assert.ok(
				env.thinkingLevelCalls.includes("xhigh"),
				`expected setThinkingLevel('xhigh'), got: ${JSON.stringify(env.thinkingLevelCalls)}`,
			);
		} finally {
			env.cleanup();
		}
	});

	test("injects instructions via before_agent_start when plan mode is active", async () => {
		const { env, ctx } = await loadEnvWithPlanModel();
		try {
			await env.events.session_start({ reason: "start" }, ctx);

			// Before /plan: no injection.
			const before = env.events.before_agent_start(
				{ systemPrompt: "base prompt" },
				ctx,
			);
			assert.equal(before, undefined, "no injection outside plan mode");

			await env.commands.plan.handler("", ctx);

			// After /plan: instructions appended.
			const after = env.events.before_agent_start(
				{ systemPrompt: "base prompt" },
				ctx,
			);
			assert.ok(after && typeof after.systemPrompt === "string");
			assert.ok(after.systemPrompt.startsWith("base prompt"));
			assert.ok(after.systemPrompt.length > "base prompt".length);
		} finally {
			env.cleanup();
		}
	});

	test("blocks configured tools via tool_call when plan mode is active", async () => {
		const { env, ctx } = await loadEnvWithPlanModel({
			blockList: ["write", "edit"],
		});
		try {
			await env.events.session_start({ reason: "start" }, ctx);
			await env.commands.plan.handler("", ctx);

			const writeResult = env.events.tool_call({ toolName: "write" }, ctx);
			assert.equal(writeResult && writeResult.block, true);
			assert.ok(
				typeof writeResult?.reason === "string" &&
					writeResult.reason.includes("write"),
			);

			const editResult = env.events.tool_call({ toolName: "edit" }, ctx);
			assert.equal(editResult.block, true);

			// Unblocked tools pass through with no decision.
			const readResult = env.events.tool_call({ toolName: "read" }, ctx);
			assert.equal(readResult, undefined);
		} finally {
			env.cleanup();
		}
	});

	test("restores the previous model and thinking level on /endplan", async () => {
		const env = new TestEnv();
		try {
			await env.loadExtension();
			env.writeConfig({
				provider: "opencode-go",
				model: "plan-model",
				thinkingLevel: "low",
			});
			const ctx = env.buildCtx({
				provider: "opencode-go",
				modelId: "user-model",
				models: [
					{ provider: "opencode-go", id: "user-model" },
					{ provider: "opencode-go", id: "plan-model" },
				],
			});
			await env.events.session_start({ reason: "start" }, ctx);

			await env.commands.plan.handler("", ctx);
			assert.equal(env.setModelResults.length, 1);
			assert.equal(env.setModelResults[0].id, "plan-model");

			await env.commands.endplan.handler("", ctx);
			assert.equal(env.setModelResults.length, 2, "model restored on endplan");
			assert.equal(env.setModelResults[1].id, "user-model");

			const last = env.thinkingLevelCalls[env.thinkingLevelCalls.length - 1];
			assert.equal(last, "high", "restored saved thinking level");
		} finally {
			env.cleanup();
		}
	});

	test("/plan is a no-op when already in plan mode", async () => {
		const { env, ctx } = await loadEnvWithPlanModel();
		try {
			await env.events.session_start({ reason: "start" }, ctx);
			await env.commands.plan.handler("", ctx);
			const callsAfterFirst = env.setModelResults.length;
			await env.commands.plan.handler("", ctx);
			assert.equal(
				env.setModelResults.length,
				callsAfterFirst,
				"no extra setModel on second /plan",
			);
			assert.ok(
				env.notifications.some(
					(n) => n.type === "info" && /already in plan mode/i.test(n.message),
				),
			);
		} finally {
			env.cleanup();
		}
	});

	test("/endplan is a no-op when not in plan mode", async () => {
		const env = new TestEnv();
		try {
			await env.loadExtension();
			const ctx = env.buildCtx();
			await env.events.session_start({ reason: "start" }, ctx);
			await env.commands.endplan.handler("", ctx);
			assert.equal(
				env.setModelResults.length,
				0,
				"no model switch when not in plan mode",
			);
			assert.ok(
				env.notifications.some(
					(n) => n.type === "info" && /not in plan mode/i.test(n.message),
				),
			);
		} finally {
			env.cleanup();
		}
	});

	test("aborts and notifies when the configured plan model is missing", async () => {
		const env = new TestEnv();
		try {
			await env.loadExtension();
			env.writeConfig({
				provider: "opencode-go",
				model: "nonexistent-model",
			});
			const ctx = env.buildCtx({
				provider: "opencode-go",
				modelId: "m",
				models: [{ provider: "opencode-go", id: "m" }],
			});
			await env.events.session_start({ reason: "start" }, ctx);

			await env.commands.plan.handler("", ctx);

			assert.equal(
				env.setModelResults.length,
				0,
				"no model switch on missing model",
			);
			assert.ok(
				env.notifications.some(
					(n) => n.type === "error" && /not found in registry/.test(n.message),
				),
			);
		} finally {
			env.cleanup();
		}
	});

	test("plan mode state persists across /reload", async () => {
		const env = new TestEnv();
		try {
			await env.loadExtension();
			env.writeConfig({
				provider: "opencode-go",
				model: "plan-model",
				blockList: ["write"],
			});

			const ctx1 = env.buildCtx({
				provider: "opencode-go",
				modelId: "user-model",
				models: [
					{ provider: "opencode-go", id: "user-model" },
					{ provider: "opencode-go", id: "plan-model" },
				],
			});
			await env.events.session_start({ reason: "start" }, ctx1);
			await env.commands.plan.handler("", ctx1);
			assert.equal(env.setModelResults.length, 1);

			const ctx2 = env.buildCtx({
				provider: "opencode-go",
				modelId: "user-model",
				models: [
					{ provider: "opencode-go", id: "user-model" },
					{ provider: "opencode-go", id: "plan-model" },
				],
			});
			env.setModelResults.length = 0;
			await env.events.session_start({ reason: "reload" }, ctx2);

			const result = env.events.tool_call({ toolName: "write" }, ctx2);
			assert.equal(
				result && result.block,
				true,
				"plan mode restored on reload",
			);
		} finally {
			env.cleanup();
		}
	});

	test("session_shutdown clears plan mode state", async () => {
		const env = new TestEnv();
		try {
			await env.loadExtension();
			env.writeConfig({
				provider: "opencode-go",
				model: "plan-model",
				blockList: ["write"],
			});
			const ctx = env.buildCtx({
				provider: "opencode-go",
				modelId: "user-model",
				models: [
					{ provider: "opencode-go", id: "user-model" },
					{ provider: "opencode-go", id: "plan-model" },
				],
			});
			await env.events.session_start({ reason: "start" }, ctx);
			await env.commands.plan.handler("", ctx);
			assert.equal(
				env.events.tool_call({ toolName: "write" }, ctx).block,
				true,
			);
			await env.events.session_shutdown({}, ctx);
			assert.equal(
				env.events.tool_call({ toolName: "write" }, ctx),
				undefined,
				"plan mode cleared on session_shutdown",
			);
		} finally {
			env.cleanup();
		}
	});
});
