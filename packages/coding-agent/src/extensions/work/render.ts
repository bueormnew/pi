/**
 * Pure template rendering for connectors: no network, no process spawn, so every rule below is
 * unit-testable without a server.
 */

import { resolveConfigValue } from "../../core/resolve-config-value.ts";
import type { WorkCommandConfig, WorkHttpRequest } from "./types.ts";

/**
 * `{{name}}` escapes for its target, `{{+name}}` inserts the value verbatim. The raw form exists for
 * one job: a JSON fragment the model wrote (a spreadsheet row), which must not be quote-escaped.
 */
const PLACEHOLDER = /\{\{\s*(\+?)([A-Za-z_][A-Za-z0-9_]*)(?::([^}]*))?\s*\}\}/g;

export type EscapeMode = "none" | "url" | "json";

function escapeValue(value: string, mode: EscapeMode): string {
	if (mode === "url") return encodeURIComponent(value);
	if (mode !== "json") return value;
	// A JSON body interpolates inside a quoted string, so quotes, backslashes and control characters
	// have to be escaped, or a body containing `"` produces a malformed request.
	return JSON.stringify(value).slice(1, -1);
}

/** Fill `{{name}}` / `{{name:default}}`, escaping for the place the value is going into. */
export function interpolate(
	template: string,
	values: Record<string, unknown>,
	escapeMode: EscapeMode = "none",
): { value: string } | { error: string } {
	let error: string | undefined;
	const value = template.replace(PLACEHOLDER, (match, raw: string, name: string, fallback?: string) => {
		const provided = values[name];
		const chosen = provided ?? fallback;
		if (chosen === undefined || chosen === null || chosen === "") {
			error = `missing value for {{${name}}}${fallback === undefined ? " (no default)" : ""}`;
			return match;
		}
		return escapeValue(String(chosen), raw === "+" ? "none" : escapeMode);
	});
	return error ? { error } : { value };
}

export function encodeBase64Url(value: string): string {
	return Buffer.from(value, "utf-8").toString("base64url");
}

/** Resolve `$ENV_VAR`, `${ENV_VAR}` and `!command` config values, reporting missing variables. */
export function resolveSecrets(template: string): { value: string } | { error: string } {
	const resolved = resolveConfigValue(template);
	if (resolved !== undefined) return { value: resolved };
	return { error: `unresolved environment variable in: ${template}` };
}

/** Merge declared defaults and the composed field into the values templates read from. */
export function prepareWorkValues(
	config: WorkCommandConfig,
	params: Record<string, unknown>,
): { values: Record<string, unknown> } | { error: string } {
	const values: Record<string, unknown> = { ...params };
	for (const [name, param] of Object.entries(config.params)) {
		if (values[name] === undefined && param.default !== undefined) values[name] = param.default;
	}
	const compose = config.compose;
	if (compose) {
		const composed = interpolate(compose.template, values);
		if ("error" in composed) return composed;
		values[compose.field] = compose.encode === "b64url" ? encodeBase64Url(composed.value) : composed.value;
	}
	return { values };
}

/**
 * Render one request. Each target is escaped differently because each breaks differently: a URL needs
 * percent-encoding, a JSON body needs quote escaping, and a header value must not contain CR or LF,
 * which would inject an additional header line.
 */
export function renderStep(
	step: WorkHttpRequest,
	values: Record<string, unknown>,
):
	| {
			request: { method: string; url: string; headers?: Record<string, string>; body?: string };
			capture?: Record<string, string>;
	  }
	| { error: string } {
	const fill = (template: string, escapeMode: EscapeMode): { value: string } | { error: string } => {
		// Secrets resolve first: a model-supplied value must never be scanned for config references.
		const secrets = resolveSecrets(template);
		if ("error" in secrets) return secrets;
		return interpolate(secrets.value, values, escapeMode);
	};

	const url = fill(step.url, "url");
	if ("error" in url) return url;
	const request: { method: string; url: string; headers?: Record<string, string>; body?: string } = {
		method: (step.method ?? "GET").toUpperCase(),
		// Only interpolated values are percent-encoded; the template's own `://`, `?` and `&` stay.
		url: url.value,
	};
	if (step.headers) {
		const headers: Record<string, string> = {};
		for (const [name, template] of Object.entries(step.headers)) {
			const value = fill(template, "none");
			if ("error" in value) return value;
			if (/[\r\n]/.test(value.value)) return { error: `header ${name} may not contain CR or LF` };
			headers[name] = value.value;
		}
		request.headers = headers;
	}
	if (step.body !== undefined) {
		const body = fill(step.body, "json");
		if ("error" in body) return body;
		request.body = body.value;
	}
	return { request, ...(step.capture ? { capture: step.capture } : {}) };
}

export type RenderedWorkCommand =
	| { kind: "command"; argv: string[] }
	| { kind: "http"; url: string; method: string; headers?: Record<string, string>; body?: string }
	| { error: string };

/**
 * Resolve a command against model-supplied values. For `http` this renders the single-request form;
 * `renderStep` is the shared primitive and `runWorkHttp` handles the multi-step case.
 */
export function renderWorkCommand(config: WorkCommandConfig, values: Record<string, unknown>): RenderedWorkCommand {
	const prepared = prepareWorkValues(config, values);
	if ("error" in prepared) return prepared;
	const merged = prepared.values;

	const fill = (template: string): { value: string } | { error: string } => {
		const secrets = resolveSecrets(template);
		if ("error" in secrets) return secrets;
		return interpolate(secrets.value, merged);
	};

	if (config.kind === "command") {
		const argv: string[] = [];
		for (const part of config.argv ?? []) {
			const filled = fill(part);
			if ("error" in filled) return filled;
			if (filled.value.length === 0) return { error: `empty argument in ${config.toolName}` };
			if (filled.value.includes("\n"))
				return { error: `newlines are not allowed in arguments for ${config.toolName}` };
			argv.push(filled.value);
		}
		if (argv.length === 0) return { error: `${config.toolName} has an empty argv` };
		return { kind: "command", argv };
	}

	const step = renderStep(
		{ method: config.method, url: config.url ?? "", headers: config.headers, body: config.body },
		merged,
	);
	if ("error" in step) return step;
	return {
		kind: "http",
		url: step.request.url,
		method: step.request.method,
		...(step.request.headers ? { headers: step.request.headers } : {}),
		...(step.request.body !== undefined ? { body: step.request.body } : {}),
	};
}
