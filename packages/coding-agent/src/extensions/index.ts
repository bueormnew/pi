import type { InlineExtension } from "../core/extensions/types.ts";
import codemodeExtension from "./codemode/index.ts";
import llamaExtension from "./llama/index.ts";
import mcpExtension from "./mcp/index.ts";
import modeExtension from "./modes/index.ts";
import planExtension from "./plan/index.ts";
import subagentExtension from "./subagent/index.ts";
import toolSearchExtension from "./tool-search/index.ts";
import workExtension from "./work/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, builtin: true },
	// Replaceable: an extension that registers `codemode`, `tool_search`, or `/mcp` (such as a third-party
	// MCP extension) takes over instead of running alongside the built-in one.
	{ name: "codemode", factory: codemodeExtension, replaceable: true, builtin: true },
	{ name: "tool-search", factory: toolSearchExtension, replaceable: true, builtin: true },
	{ name: "mcp", factory: mcpExtension, replaceable: true, builtin: true },
	// pi-lite: the mode engine gates tools for plan and work, so it loads before the tools it gates.
	{ name: "modes", factory: modeExtension, replaceable: true, builtin: true },
	{ name: "plan", factory: planExtension, replaceable: true, builtin: true },
	{ name: "subagent", factory: subagentExtension, replaceable: true, builtin: true },
	{ name: "work", factory: workExtension, replaceable: true, builtin: true },
];
