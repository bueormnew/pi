/** Connector configuration shapes, shared by the parser, the renderer and the runner. */

import type { WorkAuthConfig } from "./oauth.ts";
import type { WorkPreset } from "./presets.ts";

export type WorkParamType = "string" | "number" | "boolean";

export interface WorkParam {
	type: WorkParamType;
	description?: string;
	required?: boolean;
	default?: string | number | boolean;
}

/** One HTTP request in a connector. A connector is one of these, or a sequence. */
export interface WorkHttpRequest {
	method?: string;
	url: string;
	headers?: Record<string, string>;
	body?: string;
	/** Read values out of this response for later steps: `name -> dotted.path`, arrays by index. */
	capture?: Record<string, string>;
}

export interface WorkCommandConfig {
	/** Tool name exposed to the model, for example `gmail_search`. */
	toolName: string;
	connector: string;
	command: string;
	description: string;
	kind: "command" | "http";
	/** command kind: argv template. argv[0] is the executable; no shell is involved. */
	argv?: string[];
	/** http kind: request parts. */
	method?: string;
	url?: string;
	headers?: Record<string, string>;
	body?: string;
	/** Request sequence; when present it replaces the single `url`/`body` request. */
	steps?: WorkHttpRequest[];
	/** OAuth config used to produce the `authorization` header. */
	auth?: WorkAuthConfig;
	/**
	 * Build one extra value before rendering, from a template. Used for Gmail send, where the API
	 * wants an RFC 2822 message base64url-encoded rather than a JSON object.
	 */
	compose?: { field: string; template: string; encode?: "b64url" };
	/** `accept` header, for APIs that return an error without it. */
	accept?: string;
	params: Record<string, WorkParam>;
	readOnly: boolean;
	timeoutMs: number;
	/** Absolute path of the file this command came from, for diagnostics. */
	source: string;
}

export interface WorkDiagnostic {
	source: string;
	message: string;
}

export interface WorkConfig {
	commands: WorkCommandConfig[];
	diagnostics: WorkDiagnostic[];
	/** Files that contributed, oldest first, for `/work`. */
	sources: string[];
	/** Built-in connectors that were skipped because no credentials are reachable. */
	disabledPresets: WorkPreset[];
}
