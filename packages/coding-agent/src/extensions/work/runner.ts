/**
 * Executes a connector's HTTP steps.
 *
 * A command is one request, or a short sequence where a later request needs a value from an earlier
 * response — Google Docs has no "append to the end" verb, so appending means read
 * `body.endOfSegment.index`, then `:batchUpdate` at that index. Keeping the sequence in the connector
 * definition means the model never has to hold intermediate ids across turns.
 */

import { truncateHead } from "../../core/tools/truncate.ts";
import { pickJson } from "./json-path.ts";
import { getAccessToken } from "./oauth.ts";
import { renderStep } from "./render.ts";
import type { WorkCommandConfig, WorkHttpRequest } from "./types.ts";

const MAX_OUTPUT_BYTES = 20_000;

export interface WorkRequestSummary {
	method: string;
	url: string;
}

export interface WorkRunOutcome {
	/** Final response body, truncated for the model. */
	text: string;
	status: number | undefined;
	/** Truncated by `truncateHead`. */
	truncated: boolean;
	/** What each request was, for the tool details. Secrets never appear here. */
	requests: WorkRequestSummary[];
	/** Values captured along the way, kept in details so a follow-up call can reuse them. */
	captured: Record<string, string | number | boolean>;
}

export interface WorkRunContext {
	cwd: string;
	agentDir: string;
	signal?: AbortSignal | undefined;
	/** Told the user about an interactive sign-in (URL plus code). */
	prompt?: (message: string) => void;
}

function stepsOf(config: WorkCommandConfig): WorkHttpRequest[] {
	if (config.steps && config.steps.length > 0) return config.steps;
	if (config.url === undefined) return [];
	return [{ method: config.method, url: config.url, headers: config.headers, body: config.body }];
}

function errorMessage(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	return error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message;
}

export async function runWorkHttp(
	config: WorkCommandConfig,
	values: Record<string, unknown>,
	context: WorkRunContext,
): Promise<{ outcome: WorkRunOutcome } | { error: string }> {
	const steps = stepsOf(config);
	if (steps.length === 0) return { error: `${config.toolName} has no request to run` };

	const headers: Record<string, string> = {};
	if (config.accept) headers.accept = config.accept;

	if (config.auth) {
		const token = await getAccessToken(config.auth, {
			agentDir: context.agentDir,
			cwd: context.cwd,
			prompt: context.prompt,
		});
		if ("error" in token) return { error: `${config.toolName}: ${token.error}` };
		headers.authorization = `Bearer ${token.result.accessToken}`;
	}

	const captured: Record<string, string | number | boolean> = {};
	const requests: WorkRequestSummary[] = [];
	const merged: Record<string, unknown> = { ...values, ...captured };
	let lastText = "";
	let lastStatus: number | undefined;

	for (const step of steps) {
		const rendered = renderStep(step, merged);
		if ("error" in rendered) return { error: `${config.toolName}: ${rendered.error}` };
		const { request, capture } = rendered;
		// A step may declare its own authorization (for example a signed service token); that wins
		// over the connector-level one rather than being overwritten by it.
		const stepHeaders = { ...headers, ...(request.headers ?? {}) };
		requests.push({ method: request.method, url: request.url });

		let response: Response;
		try {
			response = await fetch(request.url, {
				method: request.method,
				headers: stepHeaders,
				body: request.body,
				signal: context.signal,
			});
		} catch (error) {
			return { error: `${config.toolName} request failed: ${errorMessage(error)}` };
		}

		const text = await response.text();
		lastStatus = response.status;
		lastText = text;
		if (!response.ok) {
			const truncated = truncateHead(text, { maxBytes: MAX_OUTPUT_BYTES });
			return {
				error: `${config.toolName} got HTTP ${response.status}: ${truncated.content.slice(0, 600)}`,
			};
		}

		if (capture) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(text) as unknown;
			} catch {
				return { error: `${config.toolName}: cannot capture from a non-JSON response` };
			}
			for (const [name, path] of Object.entries(capture)) {
				const value = pickJson(parsed, path);
				if (value === undefined) return { error: `${config.toolName}: capture path "${path}" found nothing` };
				captured[name] = value;
				merged[name] = value;
			}
		}
	}

	const truncated = truncateHead(lastText, { maxBytes: MAX_OUTPUT_BYTES });
	return {
		outcome: {
			text: truncated.content + (truncated.truncated ? `\n[truncated: ${truncated.totalBytes} bytes total]` : ""),
			status: lastStatus,
			truncated: truncated.truncated,
			requests,
			captured,
		},
	};
}
