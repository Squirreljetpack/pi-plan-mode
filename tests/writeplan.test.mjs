/**
 * Tests for /writeplan. Verifies the default target (PLAN.md), custom
 * paths, the file-conflict prompt (write/append/clear/delete), the
 * empty-file short-circuit, headless mode behavior, and the no-content
 * error.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TestEnv } from "./_helpers.mjs";

describe("/writeplan", () => {
	test("writes the last assistant text to PLAN.md by default", async () => {
		const env = new TestEnv();
		try {
			await env.loadExtension();
			env.appendUserMessage("Tell me about X");
			env.appendAssistantMessage("Here is my plan:\n1. Do A\n2. Do B");
			const ctx = env.buildCtx();
			await env.events.session_start({ reason: "start" }, ctx);

			await env.commands.writeplan.handler("", ctx);

			const content = readFileSync(join(env.tmpDir, "PLAN.md"), "utf8");
			assert.equal(content, "Here is my plan:\n1. Do A\n2. Do B");
			assert.ok(
				env.notifications.some((n) => n.type === "success"),
				"emits a success notification",
			);
		} finally {
			env.cleanup();
		}
	});

	test("writes to a custom path when given an argument", async () => {
		const env = new TestEnv();
		try {
			await env.loadExtension();
			env.appendUserMessage("Test");
			env.appendAssistantMessage("Custom plan content");
			const ctx = env.buildCtx();
			await env.events.session_start({ reason: "start" }, ctx);

			await env.commands.writeplan.handler("custom.md", ctx);

			assert.ok(existsSync(join(env.tmpDir, "custom.md")));
			assert.equal(
				readFileSync(join(env.tmpDir, "custom.md"), "utf8"),
				"Custom plan content",
			);
			assert.ok(!existsSync(join(env.tmpDir, "PLAN.md")));
		} finally {
			env.cleanup();
		}
	});

	test("writes without prompting when target file is empty", async () => {
		const env = new TestEnv();
		try {
			await env.loadExtension();
			env.appendUserMessage("Test");
			env.appendAssistantMessage("New plan");
			writeFileSync(join(env.tmpDir, "PLAN.md"), "");
			let selectCalled = false;
			const ctx = env.buildCtx();
			ctx.ui.select = async () => {
				selectCalled = true;
				return undefined;
			};
			await env.events.session_start({ reason: "start" }, ctx);

			await env.commands.writeplan.handler("", ctx);

			assert.equal(selectCalled, false, "must not prompt when file is empty");
			assert.equal(
				readFileSync(join(env.tmpDir, "PLAN.md"), "utf8"),
				"New plan",
			);
		} finally {
			env.cleanup();
		}
	});

	test("prompts for conflict resolution when file exists and is non-empty", async () => {
		const env = new TestEnv();
		try {
			await env.loadExtension();
			env.appendUserMessage("Test");
			env.appendAssistantMessage("New plan");
			writeFileSync(join(env.tmpDir, "PLAN.md"), "OLD CONTENT");
			let selectOptions;
			const ctx = env.buildCtx();
			ctx.ui.select = async (_prompt, options) => {
				selectOptions = options;
				return "write";
			};
			await env.events.session_start({ reason: "start" }, ctx);

			await env.commands.writeplan.handler("", ctx);

			assert.deepEqual(selectOptions, ["write", "append", "clear", "delete"]);
			assert.equal(
				readFileSync(join(env.tmpDir, "PLAN.md"), "utf8"),
				"New plan",
			);
		} finally {
			env.cleanup();
		}
	});

	test("appends to existing content when user selects append", async () => {
		const env = new TestEnv();
		try {
			await env.loadExtension();
			env.appendUserMessage("Test");
			env.appendAssistantMessage("New plan");
			writeFileSync(join(env.tmpDir, "PLAN.md"), "OLD");
			const ctx = env.buildCtx();
			ctx.ui.select = async () => "append";
			await env.events.session_start({ reason: "start" }, ctx);

			await env.commands.writeplan.handler("", ctx);

			assert.equal(
				readFileSync(join(env.tmpDir, "PLAN.md"), "utf8"),
				"OLD\n\nNew plan",
			);
		} finally {
			env.cleanup();
		}
	});

	test("clears existing content when user selects clear", async () => {
		const env = new TestEnv();
		try {
			await env.loadExtension();
			env.appendUserMessage("Test");
			env.appendAssistantMessage("New plan");
			writeFileSync(join(env.tmpDir, "PLAN.md"), "OLD");
			const ctx = env.buildCtx();
			ctx.ui.select = async () => "clear";
			await env.events.session_start({ reason: "start" }, ctx);

			await env.commands.writeplan.handler("", ctx);

			assert.equal(readFileSync(join(env.tmpDir, "PLAN.md"), "utf8"), "");
		} finally {
			env.cleanup();
		}
	});

	test("deletes the file when user selects delete", async () => {
		const env = new TestEnv();
		try {
			await env.loadExtension();
			env.appendUserMessage("Test");
			env.appendAssistantMessage("New plan");
			const planPath = join(env.tmpDir, "PLAN.md");
			writeFileSync(planPath, "OLD");
			const ctx = env.buildCtx();
			ctx.ui.select = async () => "delete";
			await env.events.session_start({ reason: "start" }, ctx);

			await env.commands.writeplan.handler("", ctx);

			assert.ok(!existsSync(planPath));
		} finally {
			env.cleanup();
		}
	});

	test("does nothing when user cancels the prompt", async () => {
		const env = new TestEnv();
		try {
			await env.loadExtension();
			env.appendUserMessage("Test");
			env.appendAssistantMessage("New plan");
			writeFileSync(join(env.tmpDir, "PLAN.md"), "OLD");
			const ctx = env.buildCtx();
			ctx.ui.select = async () => undefined; // user pressed esc
			await env.events.session_start({ reason: "start" }, ctx);

			await env.commands.writeplan.handler("", ctx);

			assert.equal(
				readFileSync(join(env.tmpDir, "PLAN.md"), "utf8"),
				"OLD",
				"file should be unchanged on cancel",
			);
		} finally {
			env.cleanup();
		}
	});

	test("warns and skips in headless mode when file exists", async () => {
		const env = new TestEnv();
		try {
			await env.loadExtension();
			env.appendUserMessage("Test");
			env.appendAssistantMessage("New plan");
			writeFileSync(join(env.tmpDir, "PLAN.md"), "OLD");
			let selectCalled = false;
			const ctx = env.buildCtx({ hasUI: false });
			ctx.ui.select = async () => {
				selectCalled = true;
				return "write";
			};
			await env.events.session_start({ reason: "start" }, ctx);

			await env.commands.writeplan.handler("", ctx);

			assert.equal(
				selectCalled,
				false,
				"must not call select in headless mode",
			);
			assert.equal(
				readFileSync(join(env.tmpDir, "PLAN.md"), "utf8"),
				"OLD",
				"file should be unchanged in headless mode",
			);
			assert.ok(
				env.notifications.some(
					(n) => n.type === "warning" && /already exists/.test(n.message),
				),
				"emits a warning explaining headless mode",
			);
		} finally {
			env.cleanup();
		}
	});

	test("errors when no assistant message exists in session", async () => {
		const env = new TestEnv();
		try {
			await env.loadExtension();
			env.appendUserMessage("User prompt with no response");
			const ctx = env.buildCtx();
			await env.events.session_start({ reason: "start" }, ctx);

			await env.commands.writeplan.handler("", ctx);

			assert.ok(!existsSync(join(env.tmpDir, "PLAN.md")));
			assert.ok(
				env.notifications.some(
					(n) => n.type === "error" && /no assistant message/i.test(n.message),
				),
			);
		} finally {
			env.cleanup();
		}
	});

	test("skips aborted empty assistant messages", async () => {
		const env = new TestEnv();
		try {
			await env.loadExtension();
			env.appendUserMessage("Test");
			env.appendAssistantMessage("", { stopReason: "aborted" });
			env.appendAssistantMessage("Real plan");
			const ctx = env.buildCtx();
			await env.events.session_start({ reason: "start" }, ctx);

			await env.commands.writeplan.handler("", ctx);

			assert.equal(
				readFileSync(join(env.tmpDir, "PLAN.md"), "utf8"),
				"Real plan",
				"should skip the aborted empty message and use the real one",
			);
		} finally {
			env.cleanup();
		}
	});
});
