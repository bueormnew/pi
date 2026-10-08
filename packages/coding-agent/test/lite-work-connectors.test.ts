import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
import {
	createWorkToolDefinition,
	interpolate,
	loadWorkConfig,
	parseWorkConfig,
	renderWorkCommand,
	type WorkCommandConfig,
} from "../src/extensions/work/index.ts";

const ctx = { cwd: process.cwd() } as unknown as ExtensionToolContext;

function commandConfig(overrides: Partial<WorkCommandConfig> = {}): WorkCommandConfig {
	return {
		toolName: "gmail_search",
		connector: "gmail",
		command: "search",
		description: "Search Gmail messages",
		kind: "command",
		argv: ["gog", "gmail", "search", "{{query}}", "--max", "{{max:15}}"],
		params: {
			query: { type: "string", description: "Gmail query" },
			max: { type: "number", description: "Max results", default: 15 },
		},
		readOnly: true,
		timeoutMs: 60_000,
		source: "test",
		...overrides,
	};
}

describe("work connector config", () => {
	it("parses connectors into tool commands", () => {
		const { commands, diagnostics } = parseWorkConfig(
			{
				connectors: {
					gmail: {
						description: "Mail",
						commands: {
							search: {
								description: "Search messages",
								argv: ["gog", "gmail", "search", "{{query}}"],
								params: { query: { type: "string" } },
								readOnly: true,
							},
							send: { description: "Send a message", argv: ["gog", "gmail", "send", "--to", "{{to}}"] },
						},
					},
				},
			},
			"project",
		);
		expect(diagnostics).toEqual([]);
		expect(commands.map((command) => command.toolName)).toEqual(["gmail_search", "gmail_send"]);
		expect(commands[0]?.readOnly).toBe(true);
		expect(commands[1]?.readOnly).toBe(false);
	});

	it("reports problems as diagnostics instead of throwing", () => {
		const { commands, diagnostics } = parseWorkConfig(
			{
				connectors: {
					broken: { commands: { noDescription: { argv: ["true"] } } },
					badArgv: { commands: { run: { description: "x", argv: "not-an-array" } } },
					notAnObject: "nope",
				},
			},
			"project",
		);
		expect(commands).toEqual([]);
		expect(diagnostics).toHaveLength(3);
		expect(diagnostics[0]?.message).toContain("description");
		expect(diagnostics[1]?.message).toContain("argv");
		expect(diagnostics[2]?.message).toContain("commands");
	});

	it("rejects a payload that is not a connectors object", () => {
		expect(parseWorkConfig([], "x").diagnostics[0]?.message).toContain("expected a JSON object");
		expect(parseWorkConfig({ foo: 1 }, "x").diagnostics[0]?.message).toContain('missing "connectors"');
	});

	it("keeps the first tool when two connectors collide", () => {
		const { commands, diagnostics } = parseWorkConfig(
			{
				connectors: {
					"a b": { commands: { run: { description: "first", argv: ["one"] } } },
					"a-b": { commands: { run: { description: "second", argv: ["two"] } } },
				},
			},
			"project",
		);
		expect(commands).toHaveLength(1);
		expect(commands[0]?.description).toBe("first");
		expect(diagnostics[0]?.message).toContain("duplicate tool name");
	});
});

describe("work command templates", () => {
	it("fills placeholders and applies defaults", () => {
		expect(interpolate("--max {{max:15}}", {})).toEqual({ value: "--max 15" });
		expect(interpolate("--to {{address}}", { address: "a@b.c" })).toEqual({ value: "--to a@b.c" });
		expect(interpolate("--q {{query}}", {})).toEqual({ error: "missing value for {{query}} (no default)" });
	});

	it("builds argv without a shell and applies declared defaults", () => {
		expect(renderWorkCommand(commandConfig(), { query: "from:boss is:unread" })).toEqual({
			kind: "command",
			argv: ["gog", "gmail", "search", "from:boss is:unread", "--max", "15"],
		});
	});

	it("propagates a missing value instead of sending an empty argument", () => {
		expect(renderWorkCommand(commandConfig({ params: { query: { type: "string" } } }), {})).toEqual({
			error: "missing value for {{query}} (no default)",
		});
	});

	it("refuses newlines in arguments", () => {
		expect(renderWorkCommand(commandConfig({ params: { query: { type: "string" } } }), { query: "a\nb" })).toEqual({
			error: "newlines are not allowed in arguments for gmail_search",
		});
	});

	it("resolves env secrets before model values, so arguments cannot reference variables", () => {
		process.env.LITE_WORK_TEST_TOKEN = "secret";
		try {
			const rendered = renderWorkCommand(
				commandConfig({
					params: { header: { type: "string" } },
					argv: ["curl", "-H", "authorization: $LITE_WORK_TEST_TOKEN", "{{header}}"],
				}),
				{ header: "$LITE_WORK_TEST_TOKEN" },
			);
			expect(rendered).toEqual({
				kind: "command",
				argv: ["curl", "-H", "authorization: secret", "$LITE_WORK_TEST_TOKEN"],
			});
		} finally {
			delete process.env.LITE_WORK_TEST_TOKEN;
		}
	});

	it("reports an unresolved secret", () => {
		delete process.env.LITE_WORK_MISSING_TOKEN;
		expect(
			renderWorkCommand(
				commandConfig({ params: {}, argv: ["curl", "-H", `authorization: \${LITE_WORK_MISSING_TOKEN}`] }),
				{},
			),
		).toEqual({ error: `unresolved environment variable in: authorization: \${LITE_WORK_MISSING_TOKEN}` });
	});
});

describe("work config files", () => {
	let dir: string;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "lite-work-"));
		const agentDir = join(dir, "agent");
		const projectDir = join(dir, "project");
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "work.json"),
			JSON.stringify({
				connectors: {
					mail: { commands: { search: { description: "global search", argv: ["global"] } } },
					calendar: { commands: { list: { description: "list events", argv: ["cal"] } } },
				},
			}),
		);
		writeFileSync(
			join(projectDir, ".pi", "work.json"),
			JSON.stringify({
				connectors: { mail: { commands: { search: { description: "project search", argv: ["project"] } } } },
			}),
		);
	});

	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("merges project over global", () => {
		const config = loadWorkConfig(join(dir, "project"), join(dir, "agent"));
		expect(config.commands.map((command) => command.toolName).sort()).toEqual(["calendar_list", "mail_search"]);
		expect(config.commands.find((command) => command.toolName === "mail_search")?.description).toBe("project search");
		expect(config.sources).toHaveLength(2);
	});

	it("surfaces parse errors per file", () => {
		const broken = join(dir, "broken");
		mkdirSync(join(broken, ".pi"), { recursive: true });
		writeFileSync(join(broken, ".pi", "work.json"), "{ not json");
		const config = loadWorkConfig(broken, join(dir, "agent"));
		expect(config.diagnostics[0]?.message).toContain("could not parse work.json");
	});

	it("returns nothing when no connector file exists", () => {
		const empty = join(dir, "empty");
		mkdirSync(empty, { recursive: true });
		const config = loadWorkConfig(empty, join(dir, "nope"));
		expect(config.commands).toEqual([]);
		expect(config.sources).toEqual([]);
	});
});

describe("work tools execute", () => {
	it("runs a local command and reports the exit code", async () => {
		const tool = createWorkToolDefinition(commandConfig({ params: {}, argv: ["node", "-e", "console.log(6 * 7)"] }));
		const result = await tool.execute("t1", {}, undefined, undefined, ctx);
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("42") });
		expect(result.details).toMatchObject({ exitCode: 0, shown: "node -e console.log(6 * 7)" });
	});

	it("returns an error result when the command fails", async () => {
		const tool = createWorkToolDefinition(
			commandConfig({ params: {}, argv: ["node", "-e", "console.error('nope'); process.exit(3)"] }),
		);
		const result = await tool.execute("t2", {}, undefined, undefined, ctx);
		expect(result.isError).toBe(true);
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("nope") });
		expect(result.details).toMatchObject({ exitCode: 3 });
	});

	it("posts to an http connector and returns the body", async () => {
		let server: Server | undefined;
		const port = await new Promise<number>((resolve) => {
			server = createServer((request, response) => {
				let body = "";
				request.on("data", (chunk) => {
					body += chunk;
				});
				request.on("end", () => {
					response.writeHead(200, { "content-type": "application/json" });
					response.end(JSON.stringify({ received: body, auth: request.headers.authorization }));
				});
			});
			server.listen(0, "127.0.0.1", () => resolve((server?.address() as { port: number }).port));
		});

		try {
			const tool = createWorkToolDefinition(
				commandConfig({
					kind: "http",
					argv: undefined,
					url: `http://127.0.0.1:${port}/search?q={{query}}`,
					method: "post",
					headers: { authorization: "$LITE_WORK_HTTP_TOKEN" },
					body: '{"q":"{{query}}"}',
				}),
			);
			process.env.LITE_WORK_HTTP_TOKEN = "bearer-123";
			try {
				const result = await tool.execute("t3", { query: "runbook" }, undefined, undefined, ctx);
				expect(result.content[0]).toMatchObject({ text: expect.stringContaining('"auth":"bearer-123"') });
				expect(JSON.parse(String((result.content[0] as { text: string }).text)).received).toBe('{"q":"runbook"}');
				expect(result.details).toMatchObject({ status: 200, kind: "http" });
			} finally {
				delete process.env.LITE_WORK_HTTP_TOKEN;
			}
		} finally {
			await new Promise<void>((resolve) => server?.close(() => resolve()));
		}
	});

	it("reports a connection failure as a tool error", async () => {
		const tool = createWorkToolDefinition(
			commandConfig({ kind: "http", argv: undefined, url: "http://127.0.0.1:1/nope", params: {} }),
		);
		const result = await tool.execute("t4", {}, undefined, undefined, ctx);
		expect(result.isError).toBe(true);
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("request failed") });
	});
});
