/**
 * The three pi-lite modes: `code`, `plan`, `work`.
 *
 * Problem this solves: one unrestricted agent that can edit files, run a shell and send email is
 * wrong for two thirds of the requests you make. Planning should not be able to touch anything, and
 * drafting documents in Gmail or Sheets should not be able to run `rm`. A mode is a tool policy plus
 * a paragraph of instructions, not a separate agent.
 *
 * What a mode does here:
 * - `setActiveTools` narrows what the model sees (see policy.ts for the rules);
 * - the `tool_call` hook refuses everything the mode does not allow, including third-party tools, so
 *   narrowing alone is not the guarantee;
 * - `user_bash` refuses the user's own `!` shell commands in restricted modes;
 * - `before_agent_start` injects a `<lite_mode>` prompt section and applies the mode's model.
 *
 * Configuration, in `lite.json` (global `~/.pi/agent/lite.json`, project `.pi/lite.json` wins):
 *
 *   { "mode": "work", "models": { "plan": "anthropic/claude-sonnet-4-5", "work": "openai/gpt-5.5" } }
 *
 * or `--mode plan` on the command line. The active mode is a session entry (`lite.mode`), so resume
 * and `/tree` keep it.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "../../config.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import {
	blockReason,
	isLiteMode,
	LITE_MODES,
	type LiteMode,
	MODE_POLICIES,
	modeAllowsCall,
	toolsForMode,
} from "./policy.ts";
import { getMode, parseMode, setMode, subscribeToMode } from "./store.ts";

const MODE_ENTRY = "lite.mode";
const LITE_FILE_NAME = "lite.json";

export interface LiteConfig {
	mode: LiteMode | undefined;
	models: Partial<Record<LiteMode, string>>;
	diagnostics: string[];
}

function readJsonFile(path: string): { config?: Record<string, unknown>; error?: string } {
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return { error: "expected a JSON object" };
		}
		return { config: parsed as Record<string, unknown> };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/** Merge the global and project `lite.json`. The project file wins per key. */
export function loadLiteConfig(cwd: string, agentDir: string = getAgentDir()): LiteConfig {
	const diagnostics: string[] = [];
	let mode: LiteMode | undefined;
	let models: Partial<Record<LiteMode, string>> = {};

	for (const path of [join(agentDir, LITE_FILE_NAME), join(cwd, CONFIG_DIR_NAME, LITE_FILE_NAME)]) {
		const { config, error } = readJsonFile(path);
		if (error) {
			diagnostics.push(`${path}: ${error}`);
			continue;
		}
		if (!config) continue;
		if (config.mode !== undefined) {
			const parsed = parseMode(config.mode);
			if (parsed === undefined) diagnostics.push(`${path}: "mode" must be one of ${LITE_MODES.join(", ")}`);
			else mode = parsed;
		}
		if (typeof config.models === "object" && config.models !== null && !Array.isArray(config.models)) {
			for (const [key, value] of Object.entries(config.models as Record<string, unknown>)) {
				if (!isLiteMode(key)) {
					diagnostics.push(`${path}: unknown mode "${key}" in "models"`);
					continue;
				}
				if (typeof value !== "string" || value.length === 0) {
					diagnostics.push(`${path}: models.${key} must be a "provider/model-id" string`);
					continue;
				}
				models = { ...models, [key]: value };
			}
		}
	}
	return { mode, models, diagnostics };
}

/** The mode recorded on the active branch, if any. */
export function readStoredMode(ctx: Pick<ExtensionContext, "sessionManager">): LiteMode | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type === "custom" && entry.customType === MODE_ENTRY) {
			const data = entry.data as { mode?: unknown } | undefined;
			return parseMode(data?.mode);
		}
	}
	return undefined;
}

/** CLI flag that picks the start-up mode; `--mode` belongs to pi's output modes. */
const STARTUP_FLAG = "lite-mode";

export interface ModeExtensionOptions {
	/** Overrides the file-based config, for tests and SDK hosts. */
	config?: LiteConfig;
}

export function createModeExtension(options: ModeExtensionOptions = {}): (pi: ExtensionAPI) => void {
	return (pi) => {
		let config = options.config;
		/** The set the user had before a restricted mode narrowed it. */
		let userTools: string[] | undefined;
		let pendingModelMode: LiteMode | undefined;
		let unsubscribe: (() => void) | undefined;

		const resolveConfig = (cwd: string): LiteConfig => config ?? loadLiteConfig(cwd);

		const applyTools = (mode: LiteMode): void => {
			if (MODE_POLICIES[mode].preserveTools) {
				if (userTools) pi.setActiveTools(userTools);
				return;
			}
			if (!userTools) userTools = pi.getActiveTools();
			const tools = toolsForMode(mode, pi.getAllTools());
			if (tools.length > 0) pi.setActiveTools(tools);
		};

		const showStatus = (ctx: Pick<ExtensionContext, "ui">, mode: LiteMode): void => {
			ctx.ui.setStatus("lite-mode", mode === "code" ? undefined : mode.toUpperCase());
		};

		/** Switch mode. Records the change in the session only when `record` is set. */
		const enter = (mode: LiteMode, ctx: ExtensionContext, record: boolean): void => {
			const changed = setMode(ctx.cwd, mode);
			if (!changed && !record) return;
			applyTools(mode);
			if (record) pi.appendEntry(MODE_ENTRY, { mode });
			if (resolveConfig(ctx.cwd).models[mode] !== undefined) pendingModelMode = mode;
			showStatus(ctx, mode);
		};

		pi.on("session_start", (_event, ctx) => {
			const resolved = loadLiteConfig(ctx.cwd);
			config = options.config ?? resolved;
			userTools = undefined;
			for (const diagnostic of resolved.diagnostics) ctx.ui.notify(diagnostic, "warning");

			const startupFlag = pi.getFlag(STARTUP_FLAG);
			const flagMode = typeof startupFlag === "string" ? parseMode(startupFlag) : undefined;
			if (typeof startupFlag === "string" && flagMode === undefined) {
				ctx.ui.notify(`--${STARTUP_FLAG} ignores "${startupFlag}". Expected: ${LITE_MODES.join(", ")}`, "warning");
			}
			// Precedence: a mode already in this session, then the CLI flag, then config, then code.
			const mode = readStoredMode(ctx) ?? flagMode ?? resolved.mode ?? getMode(ctx.cwd);
			setMode(ctx.cwd, mode);
			applyTools(mode);
			showStatus(ctx, mode);

			unsubscribe?.();
			unsubscribe = subscribeToMode(ctx.cwd, (next) => {
				applyTools(next);
				showStatus(ctx, next);
			});
		});

		pi.on("before_agent_start", async (event, ctx) => {
			const mode = getMode(ctx.cwd);
			showStatus(ctx, mode);
			const modelSpec = resolveConfig(ctx.cwd).models[mode];
			if (modelSpec && pendingModelMode === mode) {
				pendingModelMode = undefined;
				const [provider, ...rest] = modelSpec.split("/");
				const model = ctx.modelRegistry.find(provider, rest.join("/"));
				if (!model) {
					ctx.ui.notify(`Model ${modelSpec} for ${mode} mode is not available`, "warning");
				} else if (!(await pi.setModel(model))) {
					ctx.ui.notify(`Could not switch to ${modelSpec} for ${mode} mode`, "warning");
				}
			}
			event.systemPromptOptions.sections.lite_mode = `${MODE_POLICIES[mode].instructions}\nMode: ${mode}`;
		});

		pi.on("tool_call", (event, ctx) => {
			const mode = getMode(ctx.cwd);
			if (mode === "code") return;
			const tool = pi.getAllTools().find((candidate) => candidate.name === event.toolName);
			if (modeAllowsCall(mode, event.toolName, tool)) return;
			return { block: true, reason: blockReason(mode, event.toolName) };
		});

		pi.on("user_bash", (_event, ctx) => {
			const mode = getMode(ctx.cwd);
			if (MODE_POLICIES[mode].allowUserBash) return;
			return {
				result: {
					output: blockReason(mode, "! shell command"),
					exitCode: undefined,
					cancelled: false,
					truncated: false,
				},
			};
		});

		// Not "--mode": pi's own CLI already uses that for its output mode (text, json, rpc), and a flag
		// that is parsed before extensions see it would silently win.
		pi.registerFlag(STARTUP_FLAG, {
			type: "string",
			description: `Start in a pi-lite mode: ${LITE_MODES.join(", ")}`,
		});

		pi.registerCommand("mode", {
			description: `pi-lite modes: /mode [${LITE_MODES.join("|")}|status]. Also in lite.json.`,
			handler: async (args, ctx) => {
				const request = args.trim().toLowerCase() || "status";
				if (request === "status") {
					const mode = getMode(ctx.cwd);
					ctx.ui.notify(
						`mode: ${mode} — ${MODE_POLICIES[mode].summary}\ntools: ${pi.getActiveTools().join(", ")}`,
						"info",
					);
					return;
				}
				if (!isLiteMode(request)) {
					ctx.ui.notify(`Unknown mode "${request}". Expected: ${LITE_MODES.join(", ")}`, "error");
					return;
				}
				enter(request, ctx, true);
				ctx.ui.notify(`mode: ${request} — ${MODE_POLICIES[request].summary}`, "info");
			},
		});

		// `/plan` reads as "give me a plan", so keep it as an alias for the mode pair.
		pi.registerCommand("plan", {
			description: "Alias for /mode plan (and /mode code to leave it). `/plan off` clears plan mode.",
			handler: async (args, ctx) => {
				const request = args.trim().toLowerCase();
				const target: LiteMode = request === "off" || getMode(ctx.cwd) === "plan" ? "code" : "plan";
				enter(target, ctx, true);
				ctx.ui.notify(`mode: ${target} — ${MODE_POLICIES[target].summary}`, "info");
			},
		});
	};
}

export default createModeExtension();
