/**
 * Test setup. Idempotent: creates symlinks in node_modules/ pointing to
 * pi-coding-agent and its peers, so the test suite can resolve them from
 * both .ts files (loaded via jiti) and .mjs test files.
 *
 * Run automatically via `pretest` before the suite, or import directly.
 */
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

// Find pi-coding-agent by looking beside the running node binary.
// Same trick as bin/export-session.mjs.
const prefix = dirname(dirname(process.execPath));
const piDir = resolve(
	prefix,
	"lib",
	"node_modules",
	"@earendil-works",
	"pi-coding-agent",
);

if (!existsSync(resolve(piDir, "dist/core/export-html/index.js"))) {
	console.error(
		`test setup: pi-coding-agent not found at ${piDir}\n` +
			`Run with the node that has pi installed.`,
	);
	process.exit(2);
}

const nm = resolve(projectRoot, "node_modules");
mkdirSync(resolve(nm, "@earendil-works"), { recursive: true });

function link(src, dest) {
	if (existsSync(dest)) return;
	try {
		symlinkSync(src, dest);
	} catch {
		// EEXIST etc. — already there.
	}
}

link(piDir, resolve(nm, "@earendil-works/pi-coding-agent"));
link(
	resolve(piDir, "node_modules", "@earendil-works/pi-ai"),
	resolve(nm, "@earendil-works/pi-ai"),
);
link(resolve(piDir, "node_modules", "jiti"), resolve(nm, "jiti"));
