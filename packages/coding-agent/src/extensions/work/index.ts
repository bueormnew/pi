/**
 * Work connectors: expose local CLIs and internal HTTP APIs to the model as typed tools.
 *
 * A connector is declared in `<configDir>/work.json` (global `~/.pi/agent/work.json` and
 * project `.pi/work.json`, project wins). Each command becomes one tool named
 * `<connector>_<command>` with a schema built from its declared params, so the model calls
 * `gmail_search({ query })` instead of guessing shell flags.
 *
 * Templates support `{{param}}` and `{{param:default}}` for model-supplied values, and the same
 * `$ENV_VAR` / `${ENV_VAR}` / `!command` config-value syntax as the rest of pi's configuration for
 * secrets. Secrets resolve before model values are interpolated, so a tool argument cannot smuggle
 * in a reference to another variable.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type TSchema, Type } from "typebox";
import { CONFIG_DIR_NAME, getAgentDir } from "../../config.ts";
import { execCommand } from "../../core/exec.ts";
import { defineTool, type ExtensionAPI, type ToolDefinition } from "../../core/extensions/types.ts";
import { truncateHead } from "../../core/tools/truncate.ts";
import { parseAuthConfig } from "./oauth.ts";
import { enableHint, presetWorkConfigFragment } from "./presets.ts";
import { prepareWorkValues, renderWorkCommand } from "./render.ts";
import { runWorkHttp, type WorkRunOutcome } from "./runner.ts";
import type { WorkCommandConfig, WorkConfig, WorkDiagnostic, WorkHttpRequest, WorkParam } from "./types.ts";

export type { RenderedWorkCommand } from "./render.ts";
// The pure pieces live in render.ts/types.ts; they stay reachable from this module's path.
export { encodeBase64Url, interpolate, prepareWorkValues, renderStep, renderWorkCommand } from "./render.ts";
export type { WorkCommandConfig, WorkConfig, WorkDiagnostic, WorkHttpRequest, WorkParam } from "./types.ts";

const WORK_FILE_NAME = "work.json";
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 20_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeName(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
}

function parseParam(name: string, raw: unknown, where: string): WorkParam | string {
	if (!isRecord(raw)) return `${where}: param "${name}" must be an object`;
	const type = raw.type;
	if (type !== "string" && type !== "number" && type !== "boolean") {
		return `${where}: param "${name}" needs type "string", "number" or "boolean"`;
	}
	const param: WorkParam = { type };
	if (typeof raw.description === "string") param.description = raw.description;
	if (raw.required === false) param.required = false;
	const defaultValue = raw.default;
	if (defaultValue !== undefined) {
		if (
			typeof defaultValue !==
			typeof (param.default ?? (param.type === "string" ? "" : param.type === "number" ? 0 : false))
		) {
			return `${where}: param "${name}" default has the wrong type`;
		}
		param.default = defaultValue as string | number | boolean;
	}
	return param;
}

function parseCommand(
	connector: string,
	command: string,
	raw: unknown,
	source: string,
): { config: WorkCommandConfig } | { error: string } {
	const where = `${connector}.${command}`;
	if (!isRecord(raw)) return { error: `${where}: expected an object` };
	if (typeof raw.description !== "string" || raw.description.length === 0) {
		return { error: `${where}: "description" is required (the model only sees this text)` };
	}

	const kind = raw.kind === "http" ? "http" : "command";
	const config: WorkCommandConfig = {
		toolName: sanitizeName(`${connector}_${command}`),
		connector,
		command,
		description: raw.description,
		kind,
		params: {},
		readOnly: raw.readOnly === true,
		timeoutMs: typeof raw.timeoutMs === "number" && raw.timeoutMs > 0 ? raw.timeoutMs : DEFAULT_TIMEOUT_MS,
		source,
	};

	if (kind === "command") {
		if (!Array.isArray(raw.argv) || raw.argv.length === 0 || raw.argv.some((part) => typeof part !== "string")) {
			return { error: `${where}: "argv" must be a non-empty array of strings` };
		}
		config.argv = raw.argv as string[];
	} else if (Array.isArray(raw.steps) && raw.steps.length > 0) {
		const steps: WorkHttpRequest[] = [];
		for (const [index, rawStep] of raw.steps.entries()) {
			if (!isRecord(rawStep) || typeof rawStep.url !== "string" || rawStep.url.length === 0) {
				return { error: `${where}: steps[${index}] needs a "url"` };
			}
			const step: WorkHttpRequest = { url: rawStep.url };
			if (typeof rawStep.method === "string") step.method = rawStep.method.toUpperCase();
			if (typeof rawStep.body === "string") step.body = rawStep.body;
			if (typeof rawStep.accept === "string") config.accept = rawStep.accept;
			if (isRecord(rawStep.headers)) {
				step.headers = Object.fromEntries(
					Object.entries(rawStep.headers).filter(
						(entry): entry is [string, string] => typeof entry[1] === "string",
					),
				);
			}
			if (isRecord(rawStep.capture)) {
				step.capture = Object.fromEntries(
					Object.entries(rawStep.capture).filter(
						(entry): entry is [string, string] => typeof entry[1] === "string",
					),
				);
			}
			steps.push(step);
		}
		config.steps = steps;
	} else {
		if (typeof raw.url !== "string" || raw.url.length === 0)
			return { error: `${where}: http needs "url" or "steps"` };
		config.url = raw.url;
		config.method = typeof raw.method === "string" ? raw.method.toUpperCase() : "GET";
		if (isRecord(raw.headers)) {
			config.headers = Object.fromEntries(
				Object.entries(raw.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
			);
		}
		if (typeof raw.body === "string") config.body = raw.body;
	}

	if (typeof raw.accept === "string") config.accept = raw.accept;
	if (isRecord(raw.compose)) {
		if (typeof raw.compose.field !== "string" || typeof raw.compose.template !== "string") {
			return { error: `${where}: "compose" needs "field" and "template"` };
		}
		config.compose = {
			field: raw.compose.field,
			template: raw.compose.template,
			...(raw.compose.encode === "b64url" ? { encode: "b64url" as const } : {}),
		};
	}
	if (raw.auth !== undefined) {
		const parsed = parseAuthConfig(raw.auth);
		if ("error" in parsed) return { error: `${where}: ${parsed.error}` };
		config.auth = parsed.auth;
	}

	if (isRecord(raw.params)) {
		for (const [name, paramRaw] of Object.entries(raw.params)) {
			const parsed = parseParam(name, paramRaw, where);
			if (typeof parsed === "string") return { error: parsed };
			config.params[name] = parsed;
		}
	}
	return { config };
}

/** Parse one `work.json` payload. Never throws: every problem comes back as a diagnostic. */
export function parseWorkConfig(
	raw: unknown,
	source: string,
): {
	commands: WorkCommandConfig[];
	diagnostics: WorkDiagnostic[];
} {
	const diagnostics: WorkDiagnostic[] = [];
	if (!isRecord(raw)) return { commands: [], diagnostics: [{ source, message: "expected a JSON object" }] };
	const connectors = raw.connectors;
	if (!isRecord(connectors))
		return { commands: [], diagnostics: [{ source, message: `missing "connectors" object` }] };

	const commands: WorkCommandConfig[] = [];
	for (const [connectorName, connectorRaw] of Object.entries(connectors)) {
		const connector = sanitizeName(connectorName);
		if (connector.length === 0) {
			diagnostics.push({ source, message: `connector name "${connectorName}" has no usable characters` });
			continue;
		}
		if (!isRecord(connectorRaw) || !isRecord(connectorRaw.commands)) {
			diagnostics.push({ source, message: `${connectorName}: expected a "commands" object` });
			continue;
		}
		for (const [commandName, commandRaw] of Object.entries(connectorRaw.commands)) {
			const parsed = parseCommand(connector, sanitizeName(commandName), commandRaw, source);
			if ("error" in parsed) {
				diagnostics.push({ source, message: parsed.error });
				continue;
			}
			if (commands.some((existing) => existing.toolName === parsed.config.toolName)) {
				diagnostics.push({ source, message: `duplicate tool name ${parsed.config.toolName}; keeping the first` });
				continue;
			}
			commands.push(parsed.config);
		}
	}
	return { commands, diagnostics };
}

function readWorkFile(path: string): { raw?: unknown; error?: string } {
	if (!existsSync(path)) return {};
	try {
		return { raw: JSON.parse(readFileSync(path, "utf-8")) as unknown };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/** Load and merge the global and project connector files. */
export function loadWorkConfig(cwd: string, agentDir: string = getAgentDir()): WorkConfig {
	const paths = [join(agentDir, WORK_FILE_NAME), join(cwd, CONFIG_DIR_NAME, WORK_FILE_NAME)];
	const commands: WorkCommandConfig[] = [];
	const diagnostics: WorkDiagnostic[] = [];
	const sources: string[] = [];

	// Built-in Google/Microsoft connectors are the base layer; a hand-written work.json entry with the
	// same tool name replaces them, and a preset whose credentials are absent is not loaded at all.
	const presets = presetWorkConfigFragment(agentDir);
	if (Object.keys(presets.connectors).length > 0) {
		const parsed = parseWorkConfig({ connectors: presets.connectors }, "built-in presets");
		diagnostics.push(...parsed.diagnostics);
		commands.push(...parsed.commands);
		sources.push(`built-in presets (${presets.enabled.join(", ")})`);
	}

	for (const path of paths) {
		const { raw, error } = readWorkFile(path);
		if (error) {
			diagnostics.push({ source: path, message: `could not parse ${WORK_FILE_NAME}: ${error}` });
			continue;
		}
		if (raw === undefined) continue;
		sources.push(path);
		const parsed = parseWorkConfig(raw, path);
		diagnostics.push(...parsed.diagnostics);
		// Later files (project) win over earlier ones (global).
		for (const command of parsed.commands) {
			const index = commands.findIndex((existing) => existing.toolName === command.toolName);
			if (index >= 0) commands.splice(index, 1);
			commands.push(command);
		}
	}
	return { commands, diagnostics, sources, disabledPresets: presets.disabled };
}

function buildParamsSchema(params: Record<string, WorkParam>): TSchema {
	const properties: Record<string, TSchema> = {};
	for (const [name, param] of Object.entries(params)) {
		const options = param.description ? { description: param.description } : {};
		const base =
			param.type === "number"
				? Type.Number(options)
				: param.type === "boolean"
					? Type.Boolean(options)
					: Type.String(options);
		const optional = param.required === false || param.default !== undefined;
		properties[name] = optional ? Type.Optional(base) : base;
	}
	return Type.Object(properties, { additionalProperties: false });
}

interface WorkToolDetails {
	toolName: string;
	connector: string;
	kind: WorkCommandConfig["kind"];
	/** argv joined for display; headers and bodies are never echoed. */
	shown: string;
	exitCode?: number;
	status?: number;
	truncated: boolean;
	/** Values a step captured for a later step, kept so a follow-up call can reuse an id. */
	captured?: Record<string, string | number | boolean>;
}

/** One line describing what was called, for the tool details. Tokens never appear here. */
function summarize(config: WorkCommandConfig, outcome?: WorkRunOutcome): string {
	if (config.kind === "http" && outcome) {
		const urls = outcome.requests.map((request) => `${request.method} ${request.url}`);
		return urls.length > 1 ? `${urls.length} requests: ${urls.join(" -> ")}` : (urls[0] ?? "");
	}
	return config.kind === "http" ? `${config.method ?? "GET"} ${config.url ?? ""}` : "";
}

export function createWorkToolDefinition(config: WorkCommandConfig): ToolDefinition<TSchema, WorkToolDetails> {
	return defineTool({
		name: config.toolName,
		// The namespace is what lets work mode allow a connector's tools without naming each one.
		namespace: { name: `work:${config.connector}`, description: `${config.connector} connector` },
		label: `${config.connector} ${config.command}`,
		description: config.description,
		promptSnippet: config.description,
		promptGuidelines: [
			`For ${config.connector} work, prefer the ${config.toolName} tool over guessing shell commands`,
			...(config.readOnly ? [] : [`"${config.toolName}" changes external state; say what you are about to send`]),
		],
		parameters: buildParamsSchema(config.params),
		annotations: { readOnlyHint: config.readOnly, openWorldHint: true },
		async execute(_toolCallId, values, signal, _onUpdate, ctx) {
			const params = values as Record<string, unknown>;
			const failed = (text: string, shown: string) => ({
				content: [{ type: "text" as const, text }],
				details: {
					toolName: config.toolName,
					connector: config.connector,
					kind: config.kind,
					shown,
					truncated: false,
				},
				isError: true,
			});

			if (config.kind === "command") {
				const rendered = renderWorkCommand(config, params);
				if ("error" in rendered) return failed(rendered.error, "");
				if (rendered.kind !== "command") return failed(`${config.toolName} is not a command connector`, "");
				const [command, ...args] = rendered.argv;
				const result = await execCommand(command, args, ctx.cwd, { timeout: config.timeoutMs, signal });
				const output = `${result.stdout}${result.stderr.length > 0 ? `\n[stderr]\n${result.stderr}` : ""}`;
				const truncated = truncateHead(output, { maxBytes: MAX_OUTPUT_BYTES });
				const failedRun = result.code !== 0 || result.killed;
				return {
					content: [
						{
							type: "text",
							text:
								`${truncated.content}${truncated.truncated ? `\n[truncated: ${truncated.totalBytes} bytes total]` : ""}` +
								(failedRun ? `\n[exit ${result.code}${result.killed ? ", killed on timeout" : ""}]` : ""),
						},
					],
					details: {
						toolName: config.toolName,
						connector: config.connector,
						kind: config.kind,
						shown: rendered.argv.join(" "),
						exitCode: result.code,
						truncated: truncated.truncated,
					},
					...(failedRun ? { isError: true } : {}),
				};
			}

			const prepared = prepareWorkValues(config, params);
			if ("error" in prepared) return failed(`${config.toolName}: ${prepared.error}`, "");
			const run = await runWorkHttp(config, prepared.values, {
				cwd: ctx.cwd,
				agentDir: getAgentDir(),
				signal,
				prompt: (message) => ctx.ui.notify(message, "info"),
			});
			if ("error" in run) return failed(run.error, summarize(config));
			const { outcome } = run;
			return {
				content: [{ type: "text", text: outcome.text }],
				details: {
					toolName: config.toolName,
					connector: config.connector,
					kind: config.kind,
					shown: summarize(config, outcome),
					status: outcome.status,
					truncated: outcome.truncated,
					captured: Object.keys(outcome.captured).length > 0 ? outcome.captured : undefined,
				},
			};
		},
	});
}

export interface WorkExtensionOptions {
	/** Overrides the loaded config, for tests and SDK hosts. */
	config?: () => WorkConfig;
}

export function createWorkExtension(options: WorkExtensionOptions = {}): (pi: ExtensionAPI) => void {
	return (pi) => {
		const registered = new Set<string>();

		const load = (cwd: string): WorkConfig => (options.config ? options.config() : loadWorkConfig(cwd));

		const register = (cwd: string): WorkConfig => {
			const config = load(cwd);
			for (const command of config.commands) {
				if (registered.has(command.toolName)) continue;
				pi.registerTool(createWorkToolDefinition(command));
				registered.add(command.toolName);
			}
			return config;
		};

		pi.on("session_start", (_event, ctx) => {
			register(ctx.cwd);
		});

		pi.registerCommand("work", {
			description: "List configured work connectors, their tools, and any config errors.",
			handler: async (args, ctx) => {
				const config = args.trim() === "reload" ? register(ctx.cwd) : loadWorkConfig(ctx.cwd);
				const lines = [
					`connectors: ${config.sources.length > 0 ? config.sources.join(", ") : "(none configured)"}`,
					...[...new Set(config.commands.map((command) => command.connector))].map((connector) => {
						const names = config.commands
							.filter((command) => command.connector === connector)
							.map((command) => command.toolName)
							.join(", ");
						return `  ${connector}: ${names}`;
					}),
					...config.diagnostics.map((diagnostic) => `  ! ${diagnostic.source}: ${diagnostic.message}`),
					...(config.disabledPresets.length > 0
						? [
								`off (no credentials reachable):\n${config.disabledPresets.map((preset) => enableHint(preset)).join("\n")}`,
							]
						: []),
				];
				if (args.trim() === "reload")
					lines.push("  (reload registers new tools; changed request definitions need a restart)");
				ctx.ui.notify(lines.join("\n"), config.diagnostics.length > 0 ? "warning" : "info");
			},
		});
	};
}

export default createWorkExtension();
