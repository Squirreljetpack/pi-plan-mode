/**
 * Tests for /summarize. Verifies that the configured summarizer model
 * is invoked, the prompt + conversation are forwarded correctly, the
 * output markdown is written to summarizeDir, and the various error
 * paths (no summarizeDir, no conversation) behave as expected.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TestEnv } from "./_helpers.mjs";

describe("/summarize", () => {
	test("errors when summarizeDir is not configured", async () => {
		const env = new TestEnv();
		try {
			await env.loadExtension();
			env.appendUserMessage("User prompt");
			env.appendAssistantMessage("Assistant reply");
			const ctx = env.buildCtx();
			await env.events.session_start({ reason: "start" }, ctx);

			await env.commands.summarize.handler("", ctx);

			assert.ok(
				env.notifications.some(
					(n) => n.type === "error" && /summarizeDir/.test(n.message),
				),
				"notifies the user that summarizeDir is missing",
			);
		} finally {
			env.cleanup();
		}
	});

	test("warns when there is no conversation to summarize", async () => {
		const env = new TestEnv();
		try {
			await env.loadExtension();
			env.writeConfig({ summarizeDir: "~/my-summaries" });
			const ctx = env.buildCtx();
			await env.events.session_start({ reason: "start" }, ctx);

			await env.commands.summarize.handler("", ctx);

			assert.ok(
				env.notifications.some(
					(n) => n.type === "warning" && /no conversation/i.test(n.message),
				),
			);
			// Mock complete should not have been called.
			assert.equal(env.calls.length, 0);
		} finally {
			env.cleanup();
		}
	});

	test("writes summary markdown to summarizeDir with sanitized session id", async () => {
		const env = new TestEnv();
		try {
			await env.loadExtension();
			env.writeConfig({ summarizeDir: "~/my-summaries" });
			env.setMockResponses([
				{
					role: "assistant",
					content: [
						{ type: "text", text: "## TL;DR\nUser asked X. We did Y." },
					],
					stopReason: "stop",
					timestamp: Date.now(),
				},
			]);
			env.appendUserMessage("Build a thing");
			env.appendAssistantMessage("Ok, doing it.");
			const ctx = env.buildCtx();
			await env.events.session_start({ reason: "start" }, ctx);

			await env.commands.summarize.handler("", ctx);

			const dir = join(env.tmpHome, "my-summaries");
			assert.ok(existsSync(dir), `summarizeDir created: ${dir}`);
			const files = readdirSync(dir);
			assert.equal(files.length, 1, "exactly one summary file written");
			assert.ok(
				files[0].endsWith(".md"),
				`summary is markdown, got: ${files[0]}`,
			);
			assert.ok(
				/^\d{4}-\d{2}-\d{2}-[a-z0-9]{8}\.md$/.test(files[0]),
				`filename matches <date>-<sessionId8>.md pattern, got: ${files[0]}`,
			);
			const body = readFileSync(join(dir, files[0]), "utf8");
			assert.ok(body.startsWith("# Summary"), "body starts with a heading");
			assert.ok(
				body.includes("TL;DR"),
				"body contains the summarizer's actual response",
			);
		} finally {
			env.cleanup();
		}
	});

	test("forwards the configured summarizer prompt and the conversation", async () => {
		const env = new TestEnv();
		try {
			await env.loadExtension();
			env.writeConfig({
				summarizeDir: "~/my-summaries",
				summarizerPrompt: "Make this into 3 bullets.",
			});
			env.appendUserMessage("First user message");
			env.appendAssistantMessage("First assistant reply");
			env.appendUserMessage("Second user message");
			env.appendAssistantMessage("Second assistant reply");
			const ctx = env.buildCtx();
			await env.events.session_start({ reason: "start" }, ctx);

			await env.commands.summarize.handler("", ctx);

			assert.equal(env.calls.length, 1, "summarizer called exactly once");
			const prompt = env.calls[0].prompt;
			assert.ok(
				prompt.startsWith("Make this into 3 bullets."),
				`uses custom summarizer prompt, got: ${prompt.slice(0, 60)}…`,
			);
			assert.ok(
				prompt.includes("<conversation>"),
				"wraps the conversation in <conversation> tags",
			);
			assert.ok(prompt.includes("First user message"));
			assert.ok(prompt.includes("Second assistant reply"));
		} finally {
			env.cleanup();
		}
	});

	test("uses the configured summarizerProvider and summarizerModel", async () => {
		const env = new TestEnv();
		try {
			await env.loadExtension();
			env.writeConfig({
				summarizeDir: "~/my-summaries",
				summarizerProvider: "anthropic",
				summarizerModel: "claude-sonnet-4-5",
			});
			env.appendUserMessage("Hello");
			env.appendAssistantMessage("World");
			const ctx = env.buildCtx({
				provider: "opencode-go",
				modelId: "m",
				models: [
					{ provider: "opencode-go", id: "m" },
					{ provider: "anthropic", id: "claude-sonnet-4-5" },
				],
			});
			await env.events.session_start({ reason: "start" }, ctx);

			await env.commands.summarize.handler("", ctx);

			assert.equal(env.calls.length, 1);
			assert.equal(env.calls[0].model.provider.id, "anthropic");
			assert.equal(env.calls[0].model.id, "claude-sonnet-4-5");
		} finally {
			env.cleanup();
		}
	});

	test("falls back to the current model when no summarizer is configured", async () => {
		const env = new TestEnv();
		try {
			await env.loadExtension();
			env.writeConfig({ summarizeDir: "~/my-summaries" });
			env.appendUserMessage("Hello");
			env.appendAssistantMessage("World");
			const ctx = env.buildCtx({
				provider: "opencode-go",
				modelId: "default-model",
			});
			await env.events.session_start({ reason: "start" }, ctx);

			await env.commands.summarize.handler("", ctx);

			assert.equal(env.calls[0].model.id, "default-model");
		} finally {
			env.cleanup();
		}
	});
});
