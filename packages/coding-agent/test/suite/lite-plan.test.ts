import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import modeExtension from "../../src/extensions/modes/index.ts";
import { getMode } from "../../src/extensions/modes/store.ts";
import planExtension, { renderPlanMarkdown } from "../../src/extensions/plan/index.ts";
import { createHarness, createTestUiContext, getToolResult, type Harness } from "./harness.ts";

function stubTool(name: string, reply: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} stub`,
		parameters: Type.Object({ note: Type.Optional(Type.String()) }),
		execute: async () => ({ content: [{ type: "text", text: reply }], details: {} }),
	};
}

function planToolCall(input: Parameters<typeof fauxToolCall>[1]) {
	return fauxAssistantMessage(fauxToolCall("plan", input), { stopReason: "toolUse" });
}

describe("pi-lite plan mode", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function createPlanHarness() {
		const harness = await createHarness({
			tools: [stubTool("read", "read ok"), stubTool("edit", "EDIT RAN")],
			initialActiveToolNames: ["read", "edit", "plan"],
			extensionFactories: [modeExtension, planExtension],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });
		await harness.session.prompt("/mode plan");
		return harness;
	}

	it("registers the plan tool", async () => {
		const harness = await createHarness({ extensionFactories: [modeExtension, planExtension] });
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });
		await harness.session.prompt("/mode status");
		expect(harness.session.getActiveToolNames()).toContain("plan");
	});

	it("renders numbered steps, verification and out-of-scope items", () => {
		const markdown = renderPlanMarkdown(
			{
				title: "Add plan mode",
				steps: [{ title: "Move extension", detail: "src/extensions/plan", verify: "npm run check passes" }],
				risks: ["Conflicts with the example extension"],
				out_of_scope: ["Themes"],
			},
			"2026-01-01T00:00:00.000Z",
		);
		expect(markdown).toContain("# Add plan mode");
		expect(markdown).toContain("1. **Move extension**");
		expect(markdown).toContain("Verify: npm run check passes");
		expect(markdown).toContain("## Risks");
		expect(markdown).toContain("## Out of scope");
		expect(markdown).not.toContain("## Risks\n\n## Out of scope");
	});

	it("removes state-changing tools from the model's tool list in plan mode", async () => {
		const harness = await createPlanHarness();
		const active = harness.session.getActiveToolNames();
		expect(active).not.toContain("edit");
		expect(active).toContain("read");
		expect(active).toContain("plan");

		await harness.session.prompt("/mode code");
		expect(harness.session.getActiveToolNames()).toContain("edit");
	});

	it("never executes a state-changing call while plan mode is on", async () => {
		const harness = await createPlanHarness();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("edit", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("read", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("waiting for approval"),
		]);

		await harness.session.prompt("change the code");

		// The model is told the tool does not exist rather than being allowed to run it: plan mode withholds
		// the tool, and the mode's own refusal message is what the tool_call hook adds for re-registered tools.
		expect(getToolResult(harness, "edit").content[0]).not.toMatchObject({ text: "EDIT RAN" });
		expect(getToolResult(harness, "edit").isError).toBe(true);
		expect(getToolResult(harness, "read").content[0]).toMatchObject({ text: "read ok" });
	});

	it("executes the same call after plan mode is turned off", async () => {
		const harness = await createPlanHarness();
		await harness.session.prompt("/mode code");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("edit", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("apply it now");

		expect(getToolResult(harness, "edit").content[0]).toMatchObject({ text: "EDIT RAN" });
	});

	it("writes the plan to <configDir>/plans and records the mode in the session", async () => {
		const harness = await createPlanHarness();
		harness.setResponses([
			planToolCall({
				title: "Promote plan mode",
				steps: [{ title: "Move the example into src", verify: "tests run" }],
			}),
			fauxAssistantMessage("plan recorded"),
		]);

		await harness.session.prompt("write a plan");

		const dir = join(harness.tempDir, ".pi", "plans");
		const files = readdirSync(dir).filter((name) => name.endsWith("-promote-plan-mode.md"));
		expect(files).toHaveLength(1);
		const content = readFileSync(join(dir, files[0]!), "utf-8");
		expect(content).toContain("# Promote plan mode");
		expect(content).toContain("Move the example into src");

		// Plan mode stays on while the user has not approved, and that state is in the transcript.
		expect(getToolResult(harness, "plan").content[0]).toMatchObject({
			text: expect.stringContaining("Still in plan mode"),
		});
		expect(getMode(harness.tempDir)).toBe("plan");
		expect(existsSync(dir)).toBe(true);
	});
});
