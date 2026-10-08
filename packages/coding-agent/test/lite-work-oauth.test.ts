import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	authorizeWithDeviceFlow,
	buildAuthorizeUrl,
	cachedToken,
	clearToken,
	createPkce,
	describeTokenError,
	getAccessToken,
	parseAuthConfig,
	providerEndpoints,
	storeToken,
	type WorkAuthConfig,
	waitForAuthorizationCode,
} from "../src/extensions/work/oauth.ts";

const base64url = (buffer: Buffer) => buffer.toString("base64url");

/** A fake identity provider: authorize redirects with a code, token answers the POSTs. */
class FakeIdp {
	server: Server | undefined;
	port = 0;
	authorizeBehavior: "redirect" | "bad-state" | "deny" = "redirect";
	tokenResponses: { status: number; body: Record<string, unknown> }[] = [];
	lastTokenForm: Record<string, string> = {};
	requests: { path: string; query: URLSearchParams }[] = [];

	url(path: string): string {
		return `http://127.0.0.1:${this.port}${path}`;
	}

	async start(): Promise<void> {
		this.server = createServer(async (request, response) => {
			const url = new URL(request.url ?? "/", "http://127.0.0.1");
			this.requests.push({ path: url.pathname, query: url.searchParams });
			if (url.pathname === "/authorize") {
				const state = url.searchParams.get("state") ?? "";
				if (this.authorizeBehavior === "deny") {
					response.writeHead(302, {
						location: `${url.searchParams.get("redirect_uri")}?error=access_denied`,
					});
					response.end();
					return;
				}
				const returned = this.authorizeBehavior === "bad-state" ? "not-the-state" : state;
				response.writeHead(302, {
					location: `${url.searchParams.get("redirect_uri")}?code=THE-CODE&state=${returned}`,
				});
				response.end();
				return;
			}
			if (url.pathname === "/device") {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(
					JSON.stringify({
						device_code: "DEVICE",
						user_code: "WXYZ-EFGH",
						verification_url: "https://example.invalid/devicelogin",
						interval: 1,
						expires_in: 60,
					}),
				);
				return;
			}
			if (url.pathname === "/token") {
				const body = await readForm(request);
				this.lastTokenForm = body;
				const next = this.tokenResponses.shift() ?? { status: 400, body: { error: "unexpected_token_call" } };
				response.writeHead(next.status, { "content-type": "application/json" });
				response.end(JSON.stringify(next.body));
				return;
			}
			response.writeHead(404).end();
		});
		await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
		this.port = (this.server!.address() as { port: number }).port;
	}

	async stop(): Promise<void> {
		await new Promise<void>((resolve) => this.server?.close(() => resolve()));
		this.server = undefined;
		this.requests = [];
		this.tokenResponses = [];
	}

	accessToken(expiresIn = 3600): Record<string, unknown> {
		return { access_token: "issued-token", expires_in: expiresIn, refresh_token: "refresh-1" };
	}
}

function readForm(request: IncomingMessage): Promise<Record<string, string>> {
	return new Promise((resolve) => {
		let raw = "";
		request.on("data", (chunk: Buffer) => {
			raw += chunk.toString("utf-8");
		});
		request.on("end", () => resolve(Object.fromEntries(new URLSearchParams(raw))));
	});
}

const idp = new FakeIdp();

function authFor(overrides: Partial<WorkAuthConfig> = {}): WorkAuthConfig {
	return {
		provider: "google",
		scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
		clientId: "client-id",
		authUrl: idp.url("/authorize"),
		tokenUrl: idp.url("/token"),
		deviceAuthUrl: idp.url("/device"),
		...overrides,
	};
}

let agentDir = "";

beforeAll(async () => {
	await idp.start();
});

afterAll(async () => {
	await idp.stop();
});

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "lite-oauth-"));
	// The fake provider outlives the tests so it does not have to rebind a port; reset what it observed.
	idp.requests = [];
	idp.tokenResponses = [];
	idp.authorizeBehavior = "redirect";
});

afterEach(() => {
	for (const key of ["GOOGLE_ACCESS_TOKEN", "GOOGLE_CLIENT_ID", "AZURE_CLIENT_ID", "AZURE_TENANT_ID"])
		delete process.env[key];
	rmSync(agentDir, { recursive: true, force: true });
});

describe("PKCE and consent URLs", () => {
	it("derives the challenge from the verifier with SHA-256", () => {
		const { verifier, challenge, method } = createPkce();
		expect(method).toBe("S256");
		expect(verifier).toMatch(/^[A-Za-z0-9_-]{40,}$/);
		expect(challenge).toBe(base64url(createHash("sha256").update(verifier).digest()));
		// Two calls must not produce the same verifier.
		expect(createPkce().verifier).not.toBe(verifier);
	});

	it("puts scope, state, redirect and challenge in the authorize URL", () => {
		const url = new URL(
			buildAuthorizeUrl(authFor({ scopes: ["a", "b"] }), {
				state: "ST",
				redirectUri: "http://localhost:8743/callback",
				challenge: "CH",
			}),
		);
		expect(url.origin + url.pathname).toBe(`http://127.0.0.1:${idp.port}/authorize`);
		expect(url.searchParams.get("scope")).toBe("a b");
		expect(url.searchParams.get("response_type")).toBe("code");
		expect(url.searchParams.get("state")).toBe("ST");
		expect(url.searchParams.get("code_challenge")).toBe("CH");
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(url.searchParams.get("prompt")).toBeNull();
	});

	it("asks Microsoft for an account chooser and honours the tenant", () => {
		const previous = process.env.AZURE_TENANT_ID;
		process.env.AZURE_TENANT_ID = "contoso.onmicrosoft.com";
		const endpoints = providerEndpoints({ provider: "microsoft", scopes: ["Mail.Read"] });
		expect(endpoints.authUrl).toBe("https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/authorize");
		const url = new URL(
			buildAuthorizeUrl({ provider: "microsoft", scopes: ["Mail.Read"], clientId: "c" }, { state: "S" }),
		);
		expect(url.searchParams.get("prompt")).toBe("select_account");
		// No redirect_uri in the device-style call, so no PKCE either.
		expect(url.searchParams.get("code_challenge")).toBeNull();
		if (previous === undefined) delete process.env.AZURE_TENANT_ID;
		else process.env.AZURE_TENANT_ID = previous;
	});

	it("describes a provider error without losing the code", () => {
		expect(describeTokenError({ error: "invalid_grant", error_description: "TFP is required" })).toBe(
			"invalid_grant: TFP is required",
		);
		expect(describeTokenError({})).toBe("oauth_error");
	});
});

describe("token cache", () => {
	const auth = { provider: "google", scopes: ["s2", "s1"] } as WorkAuthConfig;

	it("keys the cache by provider and scope set, so two connectors do not share a token", () => {
		storeToken(agentDir, auth, { accessToken: "A", expiresAt: Date.now() + 60_000 }, "r1");
		expect(cachedToken(agentDir, auth)?.access.accessToken).toBe("A");
		// Same scopes in a different order are the same key.
		expect(cachedToken(agentDir, { ...auth, scopes: ["s1", "s2"] })?.access.accessToken).toBe("A");
		expect(cachedToken(agentDir, { ...auth, scopes: ["s1"] })).toBeUndefined();
		expect(cachedToken(agentDir, { ...auth, provider: "microsoft" })).toBeUndefined();
		expect(cachedToken(agentDir, auth)?.refresh).toBe("r1");
	});

	it("returns the stored expiry verbatim; the skew is applied by getAccessToken", () => {
		const expiresAt = Date.now() + 10_000;
		storeToken(agentDir, auth, { accessToken: "A", expiresAt });
		expect(cachedToken(agentDir, auth)?.access.expiresAt).toBe(expiresAt);
	});

	it("writes the file with owner-only permissions and clears on demand", () => {
		storeToken(agentDir, auth, { accessToken: "A", expiresAt: Date.now() + 60_000 }, "r1");
		const mode = statSync(join(agentDir, "work-oauth.json")).mode & 0o777;
		expect(mode).toBe(0o600);
		expect(clearToken(agentDir, auth)).toBe(true);
		expect(cachedToken(agentDir, auth)).toBeUndefined();
		expect(clearToken(agentDir, auth)).toBe(false);
	});

	it("keeps a previous refresh token when the provider does not return a new one", () => {
		storeToken(agentDir, auth, { accessToken: "A", expiresAt: Date.now() + 60_000 }, "r1");
		storeToken(agentDir, auth, { accessToken: "B", expiresAt: Date.now() + 60_000 });
		expect(cachedToken(agentDir, auth)?.refresh).toBe("r1");
		expect(cachedToken(agentDir, auth)?.access.accessToken).toBe("B");
	});

	it("survives a corrupt cache file instead of throwing at start-up", () => {
		writeFileSync(join(agentDir, "work-oauth.json"), "{ not json");
		expect(cachedToken(agentDir, auth)).toBeUndefined();
	});
});

describe("getAccessToken", () => {
	it("prefers a token the user configured over every other path", async () => {
		process.env.GOOGLE_ACCESS_TOKEN = "env-token";
		const result = await getAccessToken(authFor({ token: "$GOOGLE_ACCESS_TOKEN" }), { agentDir, cwd: agentDir });
		expect(result).toEqual({ result: { accessToken: "env-token", source: "config" } });
		expect(idp.requests).toHaveLength(0);
	});

	it("refreshes a cached token that is about to expire", async () => {
		const auth = authFor();
		storeToken(agentDir, auth, { accessToken: "almost-expired", expiresAt: Date.now() + 10_000 }, "refresh-1");
		idp.tokenResponses.push({ status: 200, body: idp.accessToken() });
		const result = await getAccessToken(auth, { agentDir, cwd: agentDir });
		expect(result).toMatchObject({ result: { accessToken: "issued-token", source: "refresh" } });
	});

	it("reuses a fresh cached token without calling the provider", async () => {
		storeToken(agentDir, authFor(), { accessToken: "cached", expiresAt: Date.now() + 3600_000 });
		const result = await getAccessToken(authFor(), { agentDir, cwd: agentDir });
		expect(result).toMatchObject({ result: { accessToken: "cached", source: "cache" } });
		expect(idp.requests).toHaveLength(0);
	});

	it("exchanges a stored refresh token and saves the answer", async () => {
		storeToken(agentDir, authFor(), { accessToken: "stale", expiresAt: Date.now() - 1000 }, "refresh-1");
		idp.tokenResponses.push({ status: 200, body: idp.accessToken() });
		const result = await getAccessToken(authFor(), { agentDir, cwd: agentDir });
		expect(result).toMatchObject({ result: { accessToken: "issued-token", source: "refresh" } });
		expect(idp.lastTokenForm.grant_type).toBe("refresh_token");
		expect(idp.lastTokenForm.refresh_token).toBe("refresh-1");
		expect(cachedToken(agentDir, authFor())?.access.accessToken).toBe("issued-token");
	});

	it("drops the cache entry when the refresh token was revoked, so consent can happen again", async () => {
		storeToken(agentDir, authFor(), { accessToken: "stale", expiresAt: Date.now() - 1000 }, "revoked");
		idp.tokenResponses.push({ status: 400, body: { error: "invalid_grant", error_description: "token revoked" } });
		const result = await getAccessToken(authFor({ clientId: undefined }), { agentDir, cwd: agentDir });
		expect(result).toMatchObject({ error: expect.stringContaining("no client id configured") });
		expect(cachedToken(agentDir, authFor())).toBeUndefined();
	});

	it("tells the user what to configure when there is neither a token nor a client id", async () => {
		const result = await getAccessToken({ provider: "google", scopes: ["s"] }, { agentDir, cwd: agentDir });
		expect(result).toMatchObject({ error: expect.stringContaining("GOOGLE_CLIENT_ID") });
	});

	it("refuses to run an auth config with no scopes", async () => {
		const result = await getAccessToken({ provider: "google", scopes: [] }, { agentDir, cwd: agentDir });
		expect(result).toMatchObject({ error: expect.stringContaining("at least one scope") });
	});

	it("completes the loopback flow and stores both tokens", async () => {
		idp.authorizeBehavior = "redirect";
		idp.tokenResponses.push({ status: 200, body: idp.accessToken() });
		const port = 18743;
		const result = await getAccessToken(authFor({ redirectPort: port }), {
			agentDir,
			cwd: agentDir,
			// No browser in a test: fetch the consent URL ourselves and follow the redirect.
			openBrowser: async (url) => {
				await fetch(url, { redirect: "follow" });
			},
		});
		expect(result).toMatchObject({ result: { accessToken: "issued-token", source: "loopback" } });
		expect(idp.lastTokenForm).toMatchObject({
			grant_type: "authorization_code",
			code: "THE-CODE",
			redirect_uri: `http://localhost:${port}/callback`,
		});
		expect(idp.lastTokenForm.code_verifier).toMatch(/^[A-Za-z0-9_-]{40,}$/);
		expect(cachedToken(agentDir, authFor())).toMatchObject({
			access: { accessToken: "issued-token" },
			refresh: "refresh-1",
		});
	});

	it("reports a provider that refused the consent screen", async () => {
		idp.authorizeBehavior = "deny";
		const result = await getAccessToken(authFor({ redirectPort: 18744 }), {
			agentDir,
			cwd: agentDir,
			openBrowser: async (url) => {
				await fetch(url, { redirect: "follow" });
			},
		});
		expect(result).toMatchObject({ error: expect.stringContaining("access_denied") });
		idp.authorizeBehavior = "redirect";
	});

	it("rejects a sign-in response whose state is not ours", async () => {
		idp.authorizeBehavior = "bad-state";
		const result = await getAccessToken(authFor({ redirectPort: 18745 }), {
			agentDir,
			cwd: agentDir,
			openBrowser: async (url) => {
				await fetch(url, { redirect: "follow" });
			},
		});
		expect(result).toMatchObject({ error: expect.stringContaining("state mismatch") });
		idp.authorizeBehavior = "redirect";
	});
});

describe("device flow", () => {
	it("prints the code, polls while pending and stores the token", async () => {
		const auth = authFor();
		const prompts: string[] = [];
		let polls = 0;
		idp.tokenResponses.push(
			{ status: 400, body: { error: "authorization_pending" } },
			{ status: 200, body: idp.accessToken(1200) },
		);
		const result = await authorizeWithDeviceFlow(auth, {
			prompt: (message) => prompts.push(message),
			sleep: async () => {
				polls += 1;
			},
		});
		expect(result).toMatchObject({ access: { accessToken: "issued-token" } });
		expect(prompts[0]).toContain("WXYZ-EFGH");
		expect(prompts[0]).toContain("https://example.invalid/devicelogin");
		expect(polls).toBe(2);
		expect(idp.requests.filter((request) => request.path === "/token")).toHaveLength(2);
		expect(idp.lastTokenForm).toMatchObject({
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			device_code: "DEVICE",
		});
	});

	it("stops when the provider rejects the grant outright", async () => {
		idp.tokenResponses.push({ status: 400, body: { error: "expired_token" } });
		const result = await authorizeWithDeviceFlow(authFor(), { sleep: async () => {} });
		expect(result).toMatchObject({ error: expect.stringContaining("expired_token") });
	});

	it("needs a client id before it will start", async () => {
		const result = await authorizeWithDeviceFlow(authFor({ clientId: undefined }), { sleep: async () => {} });
		expect(result).toMatchObject({ error: expect.stringContaining("needs a client id") });
	});

	it("runs through getAccessToken and caches the result", async () => {
		idp.tokenResponses.push({ status: 200, body: idp.accessToken() });
		const result = await getAccessToken(authFor({ flow: "device" }), { agentDir, cwd: agentDir, prompt: () => {} });
		expect(result).toMatchObject({ result: { accessToken: "issued-token", source: "device" } });
		expect(cachedToken(agentDir, authFor())?.access.accessToken).toBe("issued-token");
	});
});

describe("waitForAuthorizationCode", () => {
	it("reports a port it cannot bind instead of hanging", async () => {
		const blocker = createServer();
		await new Promise<void>((resolve) => blocker.listen(18999, "127.0.0.1", resolve));
		const result = await waitForAuthorizationCode(authFor(), { port: 18999 });
		expect(result).toMatchObject({ error: expect.stringContaining("could not listen on port 18999") });
		await new Promise<void>((resolve) => blocker.close(() => resolve()));
	});
});

describe("parseAuthConfig", () => {
	it("accepts a full google block", () => {
		const parsed = parseAuthConfig({
			provider: "google",
			scopes: [" https://www.googleapis.com/auth/gmail.send "],
			clientId: "cid",
			flow: "device",
			redirectPort: 8743,
		});
		expect(parsed).toMatchObject({
			auth: {
				provider: "google",
				scopes: ["https://www.googleapis.com/auth/gmail.send"],
				clientId: "cid",
				flow: "device",
				redirectPort: 8743,
			},
		});
	});

	it("rejects an unknown provider and an empty scope list", () => {
		expect(parseAuthConfig({ provider: "slack", scopes: ["a"] })).toMatchObject({
			error: expect.stringContaining("google"),
		});
		expect(parseAuthConfig({ provider: "google", scopes: [] })).toMatchObject({
			error: expect.stringContaining("non-empty"),
		});
		expect(parseAuthConfig({ provider: "google", scopes: ["  "] })).toMatchObject({
			error: expect.stringContaining("empty strings"),
		});
		expect(parseAuthConfig("google")).toMatchObject({ error: expect.stringContaining("object") });
		expect(parseAuthConfig(undefined)).toMatchObject({ error: expect.stringContaining("required") });
	});

	it("falls back to the environment for the client id and secret", () => {
		process.env.AZURE_CLIENT_ID = "env-client";
		const parsed = parseAuthConfig({ provider: "microsoft", scopes: ["Mail.Read"] });
		expect(parsed).toMatchObject({ auth: { clientId: "env-client" } });
		delete process.env.AZURE_CLIENT_ID;
	});
});
