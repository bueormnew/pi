import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createSubagentExtension,
	DEFAULT_MAX_TURNS,
	NEVER_SUBAGENT_TOOLS,
	resolveSubagentTools,
	type SubagentRequest,
	type SubagentSession,
} from "../../src/extensions/subagent/index.ts";
import { createHarness, createTestUiContext, getToolResult, type Harness } from "./harness.ts";

describe("pi-lite sub-agents", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("never grants the delegating, plan or session tools to a child", () => {
		expect(resolveSubagentTools({ tools: ["agent", "plan", "read"] })).toEqual(["read"]);
		expect(resolveSubagentTools({ tools: [] })).toEqual(["read", "grep", "find", "ls", "bash"]);
		expect(resolveSubagentTools({ mutate: true })).toContain("edit");
		expect(resolveSubagentTools({ mutate: true })).toContain("write");
		expect(resolveSubagentTools({ tools: ["compact"] })).toEqual([]);
		expect(resolveSubagentTools({ tools: ["agent", "plan"], mutate: true })).toEqual(["edit", "write"]);
		expect(NEVER_SUBAGENT_TOOLS).toContain("agent");
	});

	it("runs a task in a child session and returns only its answer", async () => {
		const requests: SubagentRequest[] = [];
		const runner = vi.fn(async (request: SubagentRequest) => {
			requests.push(request);
			const session: SubagentSession = {
				subscribe(listener) {
					listener({ type: "turn_start" } as never);
					listener({ type: "tool_execution_start", toolName: "read", toolCallId: "c1", input: {} } as never);
					listener({ type: "turn_end" } as never);
					return () => {};
				},
				async prompt() {
					// The child does its own work; the parent only sees the returned text.
				},
				abort() {},
				dispose() {},
				getLastAssistantText: () => "auth lives in packages/ai/src/auth, 3 call sites",
			};
			return session;
		});

		const harness = await createHarness({
			initialActiveToolNames: ["agent"],
			extensionFactories: [createSubagentExtension({ runner })],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });

		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("agent", { task: "Find where auth is implemented", label: "auth recon", max_turns: 2 }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("noted"),
		]);
		await harness.session.prompt("where is auth?");

		expect(runner).toHaveBeenCalledTimes(1);
		expect(requests[0]?.task).toBe("Find where auth is implemented");
		expect(requests[0]?.maxTurns).toBe(2);
		expect(requests[0]?.cwd).toBe(harness.tempDir);
		expect(requests[0]?.instructions[0]).toContain("You are a sub-agent");
		expect(getToolResult(harness, "agent").content[0]).toMatchObject({
			text: "auth lives in packages/ai/src/auth, 3 call sites",
		});
	});

	it("inherits the parent model and default budget when nothing is requested", async () => {
		let request: SubagentRequest | undefined;
		const runner = async (incoming: SubagentRequest) => {
			request = incoming;
			return {
				subscribe: () => () => {},
				prompt: async () => {},
				abort: () => {},
				dispose: () => {},
				getLastAssistantText: () => "done",
			} satisfies SubagentSession;
		};

		const harness = await createHarness({ extensionFactories: [createSubagentExtension({ runner })] });
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("agent", { task: "audit the loop", context: "ignore tests" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("ok"),
		]);

		await harness.session.prompt("check it");

		expect(request?.maxTurns).toBe(DEFAULT_MAX_TURNS);
		expect(request?.model?.provider).toBe(harness.getModel().provider);
		expect(request?.instructions.join(" ")).toContain("ignore tests");
	});

	it("reports a failure instead of throwing, so the parent can continue", async () => {
		const runner = async (): Promise<SubagentSession> => {
			throw new Error("child model has no credentials");
		};
		const harness = await createHarness({
			extensionFactories: [createSubagentExtension({ runner })],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("agent", { task: "boom" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("recovered"),
		]);

		await harness.session.prompt("go");

		const result = getToolResult(harness, "agent");
		expect(result.isError).toBe(true);
		expect(result.content[0]).toMatchObject({
			text: expect.stringContaining("child model has no credentials"),
		});
		expect(harness.session.getActiveToolNames().length).toBeGreaterThan(0);
	});
});
