#!/usr/bin/env node
/**
 * Generate the offline provider model catalogs that `packages/ai` normally hydrates from pi.dev.
 *
 * `packages/ai/src/providers/data/*.json` is gitignored and, upstream, refreshed from pi.dev during
 * `npm run build`. pi-lite is offline by default, so a fresh checkout cannot typecheck or run the
 * coding-agent test suite without that directory: every `providers/*.models.ts` imports one JSON file,
 * and `providers/all.ts` imports `data/.manifest.json`.
 *
 * This writes a minimal, valid catalog per provider so the module graph resolves and types check.
 * Chat model entries come from `scripts/lite-offline-models.json` when present, so a maintainer can
 * pin the handful of models this fork actually uses instead of carrying pi.dev's whole catalog.
 *
 * It never overwrites an existing file unless --force is passed, because a hydrated or hand-pinned
 * catalog is better than a stub.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const providersDir = join(repoRoot, "packages/ai/src/providers");
const dataDir = join(providersDir, "data");
const pinFile = join(repoRoot, "scripts/lite-offline-models.json");
const force = process.argv.includes("--force");

/** Fields a catalog entry needs to be a usable chat model. Extra keys pass through. */
function chatModel(provider, id, overrides = {}) {
	const api = provider === "anthropic" ? "anthropic-messages" : provider === "google" ? "google-generative-ai" : "openai-completions";
	return {
		id,
		name: id,
		api,
		provider,
		type: "chat",
		baseUrl:
			provider === "anthropic"
				? "https://api.anthropic.com"
				: provider === "google"
					? "https://generativelanguage.googleapis.com"
					: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1 },
		contextWindow: 200000,
		maxTokens: 32000,
		...overrides,
	};
}

function loadPins() {
	if (!existsSync(pinFile)) return {};
	const parsed = JSON.parse(readFileSync(pinFile, "utf-8"));
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`${pinFile} must contain an object of provider -> model id -> fields`);
	}
	return parsed;
}

function buildCatalog(provider, pins) {
	const pinned = pins[provider];
	if (!pinned) return {};
	const models = {};
	for (const [id, fields] of Object.entries(pinned)) {
		models[id] = chatModel(provider, id, fields);
	}
	// `openai-completions` is the catch-all group name for OpenAI-compatible endpoints.
	const api = Object.values(models)[0]?.api ?? "openai-completions";
	return { [api]: models };
}

const providerNames = readdirSync(providersDir)
	.filter((file) => file.endsWith(".models.ts"))
	.map((file) => file.replace(/\.models\.ts$/, ""))
	.sort();

if (providerNames.length === 0) throw new Error(`No providers/*.models.ts found in ${providersDir}`);

mkdirSync(dataDir, { recursive: true });
const pins = loadPins();
let written = 0;
let skipped = 0;

for (const provider of providerNames) {
	const target = join(dataDir, `${provider}.json`);
	if (existsSync(target) && !force) {
		skipped++;
		continue;
	}
	writeFileSync(target, `${JSON.stringify(buildCatalog(provider, pins), null, 2)}\n`, "utf8");
	written++;
}

const manifestPath = join(dataDir, ".manifest.json");
if (!existsSync(manifestPath) || force) {
	writeFileSync(
		manifestPath,
		`${JSON.stringify({ generatedAt: new Date().toISOString(), revision: "offline-local" }, null, 2)}\n`,
		"utf8",
	);
}

console.log(`offline model catalogs: ${written} written, ${skipped} kept in ${dataDir}`);
if (Object.keys(pins).length === 0) {
	console.log("no pinned models: pass scripts/lite-offline-models.json to expose real model ids");
}
