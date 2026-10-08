/**
 * Mode policies for pi-lite: `code`, `plan` and `work`.
 *
 * A mode decides three things: which tools stay declared to the model, which calls the `tool_call`
 * hook refuses, and what the model is told about the mode. Only `code` is unrestricted.
 *
 * The hook refuses anything outside the mode's allowlist rather than matching a denylist of known
 * dangerous tools, so a third-party `deploy` tool cannot slip through `plan` mode. A tool that
 * declares `annotations.readOnlyHint` is allowed in `plan` mode: that is the tool author's claim
 * about not changing state, which is exactly the property the mode needs.
 */

import type { ToolInfo } from "../../core/extensions/types.ts";

export const LITE_MODES = ["code", "plan", "work"] as const;
export type LiteMode = (typeof LITE_MODES)[number];

export const DEFAULT_MODE: LiteMode = "code";

/** Built-in tools that only read. Declared in plan mode. */
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
/** pi-lite tools available in every mode. */
export const LITE_TOOLS = ["plan", "agent"];
/** Tools `work` mode keeps: draft and inspect documents locally, no shell. */
export const WORK_TOOLS = ["read", "grep", "find", "ls", "edit", "write"];
/** Work connectors register under this namespace prefix. */
export const WORK_NAMESPACE = "work:";
/** MCP tools register under `mcp__<server>`, and stay available in every mode. */
export const MCP_NAMESPACE_PREFIX = "mcp__";
/** Tools no child session may receive, in any mode. */
export const NEVER_TOOLS = ["plan", "agent", "compact"];

export interface ModePolicy {
	/** One line for `/mode` and the footer. */
	summary: string;
	/** Whether the mode leaves the user's active tool set alone. */
	preserveTools: boolean;
	/** Whether `!` shell commands from the user run. */
	allowUserBash: boolean;
	/** Text for the `<lite_mode>` system prompt section. */
	instructions: string;
}

export const MODE_POLICIES: Record<LiteMode, ModePolicy> = {
	code: {
		summary: "Full access: read, edit, shell, connectors.",
		preserveTools: true,
		allowUserBash: true,
		instructions:
			"You are in code mode. You have your normal tool set and may change files and run commands. " +
			"For work that touches external applications (mail, docs, sheets), prefer the connector tools over shelling out.",
	},
	plan: {
		summary: "Read-only. Research, then write a plan; nothing is modified.",
		preserveTools: false,
		allowUserBash: false,
		instructions:
			"You are in plan mode. Files, commands and external applications are read-only: do not attempt to edit, " +
			"write or run anything, and do not retry a blocked call. Research with read, grep, find and ls (or a " +
			"sub-agent for breadth), then record the plan with the plan tool. Name the files and functions each step " +
			"changes and say how to verify it. The user approves the plan before any change happens.",
	},
	work: {
		summary: "Office mode: connectors plus local documents, no shell.",
		preserveTools: false,
		allowUserBash: false,
		instructions:
			"You are in work mode. Use the connector tools (gmail_*, docs_*, sheets_*, drive_*, graph_*) for external " +
			"applications, and read/edit/write for local drafts. There is no shell here: if a task needs one, say so " +
			"and ask the user to switch modes. Before sending or overwriting anything in an external application, " +
			"state the target and the exact content you are about to write.",
	},
};

export function isLiteMode(value: unknown): value is LiteMode {
	return typeof value === "string" && (LITE_MODES as readonly string[]).includes(value);
}

/**
 * The tool names a mode declares to the model, in registration order. A restricted mode takes every
 * allowed registered tool, not only the ones currently active: `grep` may be switched off by default
 * and plan mode still needs it.
 */
export function toolsForMode(
	mode: LiteMode,
	registered: readonly Pick<ToolInfo, "name" | "annotations" | "namespace">[],
): string[] {
	if (MODE_POLICIES[mode].preserveTools) return [];
	return registered.filter((tool) => modeAllowsTool(mode, tool)).map((tool) => tool.name);
}

export function modeAllowsTool(mode: LiteMode, tool: Pick<ToolInfo, "name" | "annotations" | "namespace">): boolean {
	if (mode === "code") return true;
	if (LITE_TOOLS.includes(tool.name)) return true;
	if (mode === "work") {
		return (
			WORK_TOOLS.includes(tool.name) ||
			tool.namespace?.name.startsWith(WORK_NAMESPACE) === true ||
			// Skills and MCP are part of what this fork keeps, so work mode does not hide a configured
			// MCP server: whether one of its tools may run is the server's own read-only claim.
			tool.namespace?.name.startsWith(MCP_NAMESPACE_PREFIX) === true
		);
	}
	return READ_ONLY_TOOLS.includes(tool.name) || tool.annotations?.readOnlyHint === true;
}

/** Whether a call to `toolName` may run in `mode`. */
export function modeAllowsCall(
	mode: LiteMode,
	toolName: string,
	tool: Pick<ToolInfo, "name" | "annotations" | "namespace"> | undefined,
): boolean {
	if (mode === "code") return true;
	// The tool info has to be the tool being called; a lookup that resolved to something else is a bug
	// in the caller, and refusing is the safe answer.
	if (tool === undefined || tool.name !== toolName) return false;
	return modeAllowsTool(mode, tool);
}

/**
 * The tool names a sub-agent may receive in `mode`. A child is a separate session, so the parent's
 * mode does not gate its calls: the restriction has to be applied here or plan mode leaks through
 * delegation.
 */
export function subagentToolsForMode(mode: LiteMode, requested: readonly string[]): string[] {
	const allowed = mode === "plan" ? READ_ONLY_TOOLS : mode === "work" ? WORK_TOOLS : null;
	return [...new Set(requested)].filter(
		(name) => !NEVER_TOOLS.includes(name) && (allowed === null || allowed.includes(name)),
	);
}

export function blockReason(mode: LiteMode, toolName: string): string {
	if (mode === "plan") {
		return `${toolName} is blocked in plan mode. Plan mode is read-only: research, then record the plan with the plan tool. Do not retry this call.`;
	}
	return `${toolName} is blocked in ${mode} mode. Ask the user to switch modes with /mode code if it is really needed.`;
}
