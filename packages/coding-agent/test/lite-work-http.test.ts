import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
import {
	createWorkToolDefinition,
	encodeBase64Url,
	interpolate,
	loadWorkConfig,
	parseWorkConfig,
	prepareWorkValues,
	renderStep,
} from "../src/extensions/work/index.ts";
import { pickJson } from "../src/extensions/work/json-path.ts";
import {
	enableHint,
	isPresetUsable,
	LITE_WORK_PRESETS,
	presetWorkConfigFragment,
} from "../src/extensions/work/presets.ts";
import { runWorkHttp } from "../src/extensions/work/runner.ts";
import type { WorkCommandConfig } from "../src/extensions/work/types.ts";

const ctx = { cwd: process.cwd() } as unknown as ExtensionToolContext;

function command(overrides: Partial<WorkCommandConfig>): WorkCommandConfig {
	return {
		toolName: "test_command",
		connector: "test",
		command: "command",
		description: "test",
		kind: "http",
		params: {},
		readOnly: true,
		timeoutMs: 1000,
		source: "test",
		...overrides,
	};
}

/** Records what the connector sent and answers from a scripted queue. */
class FakeApi {
	server: Server | undefined;
	port = 0;
	requests: { method: string; url: string; headers: IncomingHttpHeaders; body: string }[] = [];
	responses: { status: number; body: string }[] = [];

	get origin(): string {
		return `http://127.0.0.1:${this.port}`;
	}

	async start(): Promise<void> {
		this.server = createServer(async (request: IncomingMessage, response) => {
			let body = "";
			for await (const chunk of request) body += (chunk as Buffer).toString("utf-8");
			this.requests.push({
				method: request.method ?? "",
				url: request.url ?? "",
				headers: request.headers,
				body,
			});
			const next = this.responses.shift() ?? { status: 200, body: JSON.stringify({ ok: true }) };
			response.writeHead(next.status, { "content-type": "application/json" });
			response.end(next.body);
		});
		await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
		this.port = (this.server!.address() as { port: number }).port;
	}

	reset(): void {
		this.requests = [];
		this.responses = [];
	}
}

const api = new FakeApi();

beforeAll(async () => {
	await api.start();
});

afterAll(async () => {
	await new Promise<void>((resolve) => api.server?.close(() => resolve()));
});

describe("interpolation escaping", () => {
	it("percent-encodes values going into a URL but leaves the template's own separators alone", () => {
		const rendered = interpolate(
			"https://www.googleapis.com/drive/v3/files?q={{query}}&pageSize={{limit}}",
			{ query: "name contains 'runbook' and 'me' in owners", limit: 20 },
			"url",
		);
		expect(rendered).toEqual({
			value: "https://www.googleapis.com/drive/v3/files?q=name%20contains%20'runbook'%20and%20'me'%20in%20owners&pageSize=20",
		});
	});

	it("escapes quotes and newlines for a JSON body so the request stays parseable", () => {
		const rendered = renderStep(
			{ url: "https://example.invalid/x", body: `{"text":"{{text}}"}` },
			{ text: 'she said "hi"\nand left' },
		);
		expect(rendered).toMatchObject({ request: { body: '{"text":"she said \\"hi\\"\\nand left"}' } });
		const parsed = JSON.parse((rendered as { request: { body: string } }).request.body) as { text: string };
		expect(parsed.text).toBe('she said "hi"\nand left');
	});

	it("inserts a model-written JSON fragment verbatim with the + marker", () => {
		const rendered = renderStep(
			{ url: "https://example.invalid/x", body: `{"values":[[{{+row}}]]}` },
			{ row: `"Q3 revenue", 1200, true` },
		);
		const body = (rendered as { request: { body: string } }).request.body;
		expect(JSON.parse(body)).toEqual({ values: [["Q3 revenue", 1200, true]] });
	});

	it("refuses a header value that could inject another header line", () => {
		expect(
			renderStep(
				{ url: "https://example.invalid/x", headers: { "x-note": "{{note}}" } },
				{ note: "a\r\nx-evil: 1" },
			),
		).toMatchObject({ error: expect.stringContaining("CR or LF") });
		expect(
			renderStep({ url: "https://example.invalid/x", headers: { "x-note": "{{note}}" } }, { note: "plain" }),
		).toMatchObject({ request: { headers: { "x-note": "plain" } } });
	});

	it("reports a placeholder with neither a value nor a default", () => {
		expect(interpolate("{{missing}}", {})).toMatchObject({
			error: expect.stringContaining("no default"),
		});
		expect(interpolate("{{missing:fallback}}", {})).toEqual({ value: "fallback" });
	});
});

describe("composed payloads", () => {
	it("builds and base64url-encodes the RFC 2822 message Gmail wants", () => {
		const config = command({
			toolName: "gmail_send",
			connector: "gmail",
			command: "send",
			readOnly: false,
			url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
			body: `{"raw":"{{raw}}"}`,
			compose: {
				field: "raw",
				template:
					'To: {{to}}\r\nSubject: {{subject}}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\n{{body}}',
				encode: "b64url",
			},
			params: {
				to: { type: "string" },
				subject: { type: "string" },
				body: { type: "string" },
			},
		});
		const prepared = prepareWorkValues(config, {
			to: "ana@corp.com",
			subject: 'Re: "Q3"',
			body: "line one\nline two",
		});
		const rendered = renderStep(
			{ url: config.url ?? "", body: config.body },
			(prepared as { values: Record<string, unknown> }).values,
		);
		// The composed field is what the body reads, and it is the encoding of the message, not the message.
		expect((prepared as { values: Record<string, string> }).values.raw).toBe(
			encodeBase64Url(
				'To: ana@corp.com\r\nSubject: Re: "Q3"\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\nline one\nline two',
			),
		);
		const body = JSON.parse((rendered as { request: { body: string } }).request.body) as { raw: string };
		const message = Buffer.from(body.raw, "base64url").toString("utf-8");
		expect(message.split("\r\n").slice(0, 2)).toEqual(["To: ana@corp.com", 'Subject: Re: "Q3"']);
		expect(message.endsWith("line one\nline two")).toBe(true);
	});
});

describe("request sequences", () => {
	beforeAll(() => api.reset());

	it("captures a value from the first response and uses it in the second", async () => {
		api.reset();
		api.responses.push(
			{ status: 200, body: JSON.stringify({ files: [{ id: "FILE-1", name: "runbook.md" }] }) },
			{ status: 200, body: JSON.stringify({ ok: "appended" }) },
		);
		const config = command({
			toolName: "drive_append_note",
			steps: [
				{ url: `${api.origin}/files?q={{query}}`, capture: { fileId: "files.0.id", name: "files.0.name" } },
				{ url: `${api.origin}/files/{{fileId}}/notes`, method: "POST", body: `{"text":"about {{name}}"}` },
			],
			params: { query: { type: "string" } },
		});
		const run = await runWorkHttp(
			config,
			{ query: "runbook" },
			{ cwd: process.cwd(), agentDir: mkdtempSync(join(tmpdir(), "lite-work-")) },
		);
		expect(run).toMatchObject({ outcome: { text: JSON.stringify({ ok: "appended" }) } });
		const outcome = (run as { outcome: { captured: Record<string, string>; requests: { method: string }[] } })
			.outcome;
		expect(outcome.captured).toEqual({ fileId: "FILE-1", name: "runbook.md" });
		expect(outcome.requests.map((request) => request.method)).toEqual(["GET", "POST"]);
		expect(api.requests[1]?.url).toBe("/files/FILE-1/notes");
		expect(JSON.parse(api.requests[1]?.body ?? "{}")).toEqual({ text: "about runbook.md" });
	});

	it("stops with a message naming the step that failed", async () => {
		api.reset();
		api.responses.push({ status: 403, body: JSON.stringify({ error: { message: "insufficient scopes" } }) });
		const config = command({
			toolName: "docs_append",
			steps: [{ url: `${api.origin}/doc`, method: "POST", body: `{"text":"{{text}}"}` }],
			params: { text: { type: "string" } },
		});
		const run = await runWorkHttp(
			config,
			{ text: "hi" },
			{ cwd: process.cwd(), agentDir: mkdtempSync(join(tmpdir(), "lite-work-")) },
		);
		expect(run).toMatchObject({ error: expect.stringContaining("insufficient scopes") });
		expect(run).toMatchObject({ error: expect.stringContaining("HTTP 403") });
	});

	it("refuses to capture from a path that is not there instead of sending a broken second request", async () => {
		api.reset();
		api.responses.push({ status: 200, body: JSON.stringify({ files: [] }) });
		const config = command({
			toolName: "drive_append_note",
			steps: [
				{ url: `${api.origin}/files`, capture: { fileId: "files.0.id" } },
				{ url: `${api.origin}/files/{{fileId}}`, method: "POST", body: `{"x":"1"}` },
			],
		});
		const run = await runWorkHttp(
			config,
			{},
			{ cwd: process.cwd(), agentDir: mkdtempSync(join(tmpdir(), "lite-work-")) },
		);
		expect(run).toMatchObject({ error: expect.stringContaining('capture path "files.0.id"') });
		expect(api.requests).toHaveLength(1);
	});
});

describe("authorization header", () => {
	it("injects the configured token and never puts it in the tool details", async () => {
		process.env.GOOGLE_ACCESS_TOKEN = "secret-token";
		api.reset();
		const agentDir = mkdtempSync(join(tmpdir(), "lite-work-"));
		try {
			const config = command({
				toolName: "gmail_search",
				connector: "gmail",
				url: `${api.origin}/gmail?q={{query}}`,
				params: { query: { type: "string" } },
				auth: {
					provider: "google",
					scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
					token: "$GOOGLE_ACCESS_TOKEN",
				},
			});
			const result = await createWorkToolDefinition(config).execute(
				"call-1",
				{ query: "hello there" },
				undefined,
				() => {},
				ctx,
			);
			expect(api.requests[0]?.headers.authorization).toBe("Bearer secret-token");
			expect(api.requests[0]?.url).toBe("/gmail?q=hello%20there");
			const shown = JSON.stringify(result.details);
			expect(shown).not.toContain("secret-token");
			expect(shown).toContain("GET");
		} finally {
			delete process.env.GOOGLE_ACCESS_TOKEN;
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("tells the model to sign in when no token can be produced", async () => {
		const config = command({
			toolName: "gmail_search",
			url: `${api.origin}/gmail`,
			auth: { provider: "google", scopes: ["s"] },
		});
		const result = await createWorkToolDefinition(config).execute("call-2", {}, undefined, () => {}, ctx);
		expect(result.isError).toBe(true);
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("GOOGLE_CLIENT_ID") });
	});
});

describe("pickJson", () => {
	it("walks objects and indexes arrays", () => {
		const value = { a: [{ b: "x" }, { b: 2 }], n: { m: true } };
		expect(pickJson(value, "a.0.b")).toBe("x");
		expect(pickJson(value, "a.1.b")).toBe(2);
		expect(pickJson(value, "n.m")).toBe(true);
		expect(pickJson(value, "a.9.b")).toBeUndefined();
		expect(pickJson(value, "n.m.deep")).toBeUndefined();
		expect(pickJson(value, "obj")).toBeUndefined();
	});
});

describe("built-in presets", () => {
	it("parse through the same validator as a hand-written config, with no diagnostics", () => {
		const fragment = presetWorkConfigFragment(mkdtempSync(join(tmpdir(), "lite-presets-")), {
			GOOGLE_ACCESS_TOKEN: "t",
			AZURE_ACCESS_TOKEN: "t",
		} as NodeJS.ProcessEnv);
		expect(fragment.enabled.sort()).toEqual(["calendar", "docs", "drive", "gmail", "graph", "sheets"]);
		const parsed = parseWorkConfig({ connectors: fragment.connectors }, "presets");
		expect(parsed.diagnostics).toEqual([]);
		expect(parsed.commands.length).toBeGreaterThanOrEqual(14);
		expect(new Set(parsed.commands.map((config) => config.toolName)).size).toBe(parsed.commands.length);
	});

	it("only reach real vendor hosts, always over https, and always carry scopes", () => {
		const parsed = parseWorkConfig(
			{
				connectors: presetWorkConfigFragment(mkdtempSync(join(tmpdir(), "lite-presets-")), {
					GOOGLE_ACCESS_TOKEN: "t",
					AZURE_ACCESS_TOKEN: "t",
				} as NodeJS.ProcessEnv).connectors,
			},
			"presets",
		).commands;
		const hosts = new Set<string>();
		for (const config of parsed) {
			expect(config.kind).toBe("http");
			const steps = config.steps ?? [{ url: config.url ?? "" }];
			for (const step of steps) {
				const url = new URL(step.url);
				hosts.add(url.hostname);
				expect(url.protocol).toBe("https:");
			}
			expect(config.auth).toBeDefined();
			expect(config.auth?.scopes.length).toBeGreaterThan(0);
		}
		expect([...hosts].sort()).toEqual([
			"docs.googleapis.com",
			"gmail.googleapis.com",
			"graph.microsoft.com",
			"sheets.googleapis.com",
			"www.googleapis.com",
		]);
	});

	it("mark write commands as not read-only so plan mode drops them and work mode warns", () => {
		const parsed = parseWorkConfig(
			{
				connectors: presetWorkConfigFragment(mkdtempSync(join(tmpdir(), "lite-presets-")), {
					GOOGLE_ACCESS_TOKEN: "t",
					AZURE_ACCESS_TOKEN: "t",
				} as NodeJS.ProcessEnv).connectors,
			},
			"presets",
		).commands;
		const byName = new Map(parsed.map((config) => [config.toolName, config]));
		expect(byName.get("gmail_search")?.readOnly).toBe(true);
		expect(byName.get("gmail_send")?.readOnly).toBe(false);
		expect(byName.get("docs_append")?.readOnly).toBe(false);
		expect(byName.get("sheets_append")?.readOnly).toBe(false);
		expect(byName.get("graph_word_append")?.readOnly).toBe(false);
		expect(byName.get("graph_mail_send")?.readOnly).toBe(false);
	});

	it("stay off until credentials are reachable, and say exactly what to set", () => {
		const dir = mkdtempSync(join(tmpdir(), "lite-detect-"));
		try {
			const gmail = LITE_WORK_PRESETS.find((preset) => preset.name === "gmail")!;
			expect(isPresetUsable(gmail, dir, {})).toBe(false);
			expect(isPresetUsable(gmail, dir, { GOOGLE_ACCESS_TOKEN: "t" })).toBe(true);
			expect(isPresetUsable(gmail, dir, { GOOGLE_CLIENT_ID: "c" })).toBe(true);
			expect(isPresetUsable(gmail, dir, { AZURE_ACCESS_TOKEN: "t" })).toBe(false);
			// A cached consent for that provider is enough.
			writeFileSync(
				join(dir, "work-oauth.json"),
				JSON.stringify({ "google:https://www.googleapis.com/auth/gmail.readonly": {} }),
			);
			expect(isPresetUsable(gmail, dir, {})).toBe(true);
			expect(enableHint(gmail)).toContain("GOOGLE_CLIENT_ID");
			expect(enableHint(gmail)).toContain("Google Cloud console");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("let a project work.json entry replace a preset command of the same name", () => {
		const dir = mkdtempSync(join(tmpdir(), "lite-override-"));
		const agentDir = join(dir, "agent");
		try {
			mkdirSync(join(dir, ".pi"), { recursive: true });
			mkdirSync(agentDir, { recursive: true });
			writeFileSync(
				join(dir, ".pi", "work.json"),
				JSON.stringify({
					connectors: {
						gmail: {
							commands: {
								search: {
									description: "Local inbox dump",
									kind: "command",
									argv: ["cat", "inbox.json"],
									readOnly: true,
								},
							},
						},
					},
				}),
			);
			const config = loadWorkConfig(dir, agentDir);
			const gmailSearch = config.commands.filter((candidate) => candidate.toolName === "gmail_search");
			expect(gmailSearch).toHaveLength(1);
			expect(gmailSearch[0]?.kind).toBe("command");
			expect(gmailSearch[0]?.source).toContain(".pi");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
