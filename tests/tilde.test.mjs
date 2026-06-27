/**
 * Tests for ~ expansion in directory fields. Verifies that
 * "~/foo" resolves to $HOME/foo in the loaded config, and that
 * absolute paths are left alone.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { TestEnv } from "./_helpers.mjs";

describe("~ expansion in config directory fields", () => {
	test("summarizeDir: ~/my-summaries expands to $HOME/my-summaries", async () => {
		const env = new TestEnv();
		try {
			await env.loadExtension();
			env.writeConfig({ summarizeDir: "~/my-summaries" });
			env.appendUserMessage("Hi");
			env.appendAssistantMessage("Hello");
			const ctx = env.buildCtx();
			await env.events.session_start({ reason: "start" }, ctx);

			await env.commands.summarize.handler("", ctx);

			const expected = join(env.tmpHome, "my-summaries");
			assert.ok(
				existsSync(expected),
				`directory was created at the expanded path: ${expected}`,
			);
			// And no literal '~' directory was created in the cwd.
			assert.ok(
				!existsSync(join(env.tmpDir, "~")),
				"no literal '~' dir was created in cwd",
			);
		} finally {
			env.cleanup();
		}
	});

	test("absolute paths are left alone", async () => {
		const env = new TestEnv();
		try {
			await env.loadExtension();
			const absPath = join(env.tmpDir, "abs", "summaries");
			env.writeConfig({ summarizeDir: absPath });
			env.appendUserMessage("Hi");
			env.appendAssistantMessage("Hello");
			const ctx = env.buildCtx();
			await env.events.session_start({ reason: "start" }, ctx);

			await env.commands.summarize.handler("", ctx);

			assert.ok(existsSync(absPath), "absolute path used as-is");
			assert.ok(
				!existsSync(join(env.tmpHome, absPath)),
				"absolute path was not joined with HOME",
			);
		} finally {
			env.cleanup();
		}
	});

	test("relative paths resolve against process.cwd()", async () => {
		// The extension uses path.resolve(dir, file), which interprets relative
		// paths against process.cwd(). Change to env.tmpDir to make this
		// test deterministic regardless of how the suite is invoked.
		const env = new TestEnv();
		const origCwd = process.cwd();
		process.chdir(env.tmpDir);
		try {
			await env.loadExtension();
			env.writeConfig({ summarizeDir: "local-summaries" });
			env.appendUserMessage("Hi");
			env.appendAssistantMessage("Hello");
			const ctx = env.buildCtx();
			await env.events.session_start({ reason: "start" }, ctx);

			await env.commands.summarize.handler("", ctx);

			assert.ok(
				existsSync(join(env.tmpDir, "local-summaries")),
				"relative path resolves to process.cwd()",
			);
			assert.ok(
				!existsSync(join(env.tmpHome, "local-summaries")),
				"relative path is not joined with HOME",
			);
		} finally {
			process.chdir(origCwd);
			env.cleanup();
		}
	});
});
