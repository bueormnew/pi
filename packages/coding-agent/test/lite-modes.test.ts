import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { loadLiteConfig, readStoredMode } from "../src/extensions/modes/index.ts";
import {
	blockReason,
	isLiteMode,
	LITE_MODES,
	modeAllowsCall,
	modeAllowsTool,
	subagentToolsForMode,
	toolsForMode,
} from "../src/extensions/modes/policy.ts";

function tool(name: string, extra: { readOnlyHint?: boolean; namespace?: string } = {}) {
	return {
		name,
		...(extra.readOnlyHint === undefined ? {} : { annotations: { readOnlyHint: extra.readOnlyHint } }),
		...(extra.namespace === undefined ? {} : { namespace: { name: extra.namespace, description: "" } }),
	};
}

describe("mode policy", () => {
	it("keeps exactly the three modes and defaults to code", () => {
		expect(LITE_MODES).toEqual(["code", "plan", "work"]);
		expect(isLiteMode("plan")).toBe(true);
		expect(isLiteMode("turbo")).toBe(false);
		expect(modeAllowsCall("code", "bash", undefined)).toBe(true);
	});

	it("plan mode allows read-only built-ins and tools the author marks read-only", () => {
		expect(modeAllowsTool("plan", tool("read"))).toBe(true);
		expect(modeAllowsTool("plan", tool("grep"))).toBe(true);
		expect(modeAllowsTool("plan", tool("edit"))).toBe(false);
		expect(modeAllowsTool("plan", tool("bash"))).toBe(false);
		expect(modeAllowsTool("plan", tool("gmail_search", { readOnlyHint: true }))).toBe(true);
		expect(modeAllowsTool("plan", tool("deploy", { readOnlyHint: true }))).toBe(true);
	});

	it("a third-party mutating tool cannot slip through plan mode", () => {
		expect(modeAllowsTool("plan", tool("deploy"))).toBe(false);
		expect(modeAllowsCall("plan", "deploy", tool("deploy"))).toBe(false);
		// An unknown tool name is refused rather than allowed by omission.
		expect(modeAllowsCall("plan", "mystery", undefined)).toBe(false);
	});

	it("plan mode keeps the pi-lite tools even though they are not in the read-only list", () => {
		expect(modeAllowsTool("plan", tool("plan"))).toBe(true);
		expect(modeAllowsTool("plan", tool("agent"))).toBe(true);
	});

	it("work mode allows connectors by namespace plus local document tools, and no shell", () => {
		expect(modeAllowsTool("work", tool("gmail_send", { namespace: "work:gmail" }))).toBe(true);
		expect(modeAllowsTool("work", tool("docs_append", { namespace: "work:docs" }))).toBe(true);
		expect(modeAllowsTool("work", tool("edit"))).toBe(true);
		expect(modeAllowsTool("work", tool("bash"))).toBe(false);
		expect(modeAllowsTool("work", tool("deploy"))).toBe(false);
	});

	it("restricted modes declare every allowed registered tool, not only the active ones", () => {
		const registered = [tool("read"), tool("grep"), tool("edit"), tool("plan")];
		expect(toolsForMode("plan", registered)).toEqual(["read", "grep", "plan"]);
		// code mode returns [] meaning "leave the user's list alone"
		expect(toolsForMode("code", registered)).toEqual([]);
	});

	it("keeps MCP tools in work mode, and gates them by their own read-only claim in plan mode", () => {
		const jira = tool("jira_create", { namespace: "mcp__atlassian" });
		const jiraRead = tool("jira_search", { namespace: "mcp__atlassian", readOnlyHint: true });
		expect(modeAllowsTool("work", jira)).toBe(true);
		expect(modeAllowsTool("plan", jiraRead)).toBe(true);
		expect(modeAllowsTool("plan", jira)).toBe(false);
		// codemode can spawn a shell, so the office mode does not accept it.
		expect(modeAllowsTool("work", tool("codemode"))).toBe(false);
	});

	it("refusal text names the mode and tells the model not to retry", () => {
		expect(blockReason("plan", "edit")).toContain("blocked in plan mode");
		expect(blockReason("plan", "edit")).toContain("Do not retry");
		expect(blockReason("work", "bash")).toContain("/mode code");
	});

	it("sub-agents inherit the mode's restriction and never get the mode tools", () => {
		expect(subagentToolsForMode("plan", ["read", "edit", "bash"])).toEqual(["read"]);
		expect(subagentToolsForMode("work", ["read", "edit", "bash", "gmail_send"])).toEqual(["read", "edit"]);
		expect(subagentToolsForMode("code", ["read", "edit", "agent", "compact"])).toEqual(["read", "edit"]);
		expect(subagentToolsForMode("plan", ["read", "plan", "agent"])).toEqual(["read"]);
	});
});

describe("lite.json", () => {
	it("reads the default mode and per-mode models, and never throws on bad config", () => {
		const dir = mkdtempSync(join(tmpdir(), "lite-modes-"));
		try {
			const agentDir = join(dir, "agent");
			mkdirSync(agentDir, { recursive: true });
			writeFileSync(
				join(agentDir, "lite.json"),
				JSON.stringify({ mode: "work", models: { plan: "anthropic/claude-opus-4-8" } }),
			);
			expect(loadLiteConfig(dir, agentDir)).toMatchObject({
				mode: "work",
				models: { plan: "anthropic/claude-opus-4-8" },
				diagnostics: [],
			});

			// A project file overrides the global one.
			mkdirSync(join(dir, ".pi"), { recursive: true });
			writeFileSync(join(dir, ".pi", "lite.json"), JSON.stringify({ mode: "plan" }));
			expect(loadLiteConfig(dir, agentDir).mode).toBe("plan");

			writeFileSync(join(agentDir, "lite.json"), "{ not json");
			mkdirSync(join(dir, ".pi"), { recursive: true });
			writeFileSync(join(dir, ".pi", "lite.json"), JSON.stringify({ mode: "plan" }));
			const broken = loadLiteConfig(dir, agentDir);
			expect(broken.mode).toBe("plan");
			expect(broken.diagnostics.length).toBeGreaterThan(0);

			// A missing global file is not a problem; the project file still applies.
			expect(loadLiteConfig(dir, join(dir, "missing"))).toMatchObject({ mode: "plan" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("ignores a mode value that is not one of the three", () => {
		const dir = mkdtempSync(join(tmpdir(), "lite-modes-"));
		try {
			mkdirSync(join(dir, ".pi"), { recursive: true });
			writeFileSync(join(dir, ".pi", "lite.json"), JSON.stringify({ mode: "sleep" }));
			expect(loadLiteConfig(dir, join(dir, "agent")).mode).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("mode persistence", () => {
	type Context = Pick<ExtensionContext, "sessionManager">;

	function contextWithBranch(branch: unknown[]): Context {
		return { sessionManager: { getBranch: () => branch } } as unknown as Context;
	}

	const modeEntry = (mode: unknown) => ({ type: "custom", customType: "lite.mode", data: { mode } });

	it("takes the mode from the newest entry on the branch", () => {
		expect(readStoredMode(contextWithBranch([modeEntry("code"), modeEntry("work"), modeEntry("plan")]))).toBe("plan");
		expect(readStoredMode(contextWithBranch([{ type: "message" }, modeEntry("work")]))).toBe("work");
	});

	it("returns undefined when nothing was recorded or the recorded value is not a mode", () => {
		expect(readStoredMode(contextWithBranch([]))).toBeUndefined();
		expect(readStoredMode(contextWithBranch([{ type: "message" }]))).toBeUndefined();
		expect(readStoredMode(contextWithBranch([modeEntry("sleep")]))).toBeUndefined();
		// A foreign custom entry must not be mistaken for the mode entry.
		expect(
			readStoredMode(contextWithBranch([{ type: "custom", customType: "other", data: { mode: "plan" } }])),
		).toBeUndefined();
	});
});
