/**
 * OAuth for work connectors: get a Bearer token for Google Workspace or Microsoft Graph.
 *
 * Four sources, tried in this order, because the cheapest one that works beats the most correct one
 * that needs setup:
 *
 * 1. `token`: a config value the user wrote, e.g. `"!gcloud auth print-access-token"` or
 *    `"$MY_ACCESS_TOKEN"`. No client id, no browser, works headless.
 * 2. the cached token in `<agentDir>/work-oauth.json`, reused until 60s before its expiry.
 * 3. `refresh_token` exchange against the provider's token endpoint, so a one-time sign-in survives
 *    restarts.
 * 4. an interactive consent flow: PKCE + loopback redirect when a browser is reachable, device flow
 *    when it is not (headless, SSH, CI with a human).
 *
 * Refresh and the exchange are plain form POSTs, so every path is testable against a local server.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { resolveConfigValue } from "../../core/resolve-config-value.ts";

export type OAuthProvider = "google" | "microsoft";

export interface WorkAuthConfig {
	provider: OAuthProvider;
	scopes: string[];
	/** Config value producing an access token: `!command` or `$ENV_VAR`. Wins over every other path. */
	token?: string;
	clientId?: string;
	clientSecret?: string;
	/** "loopback" (default) opens a browser; "device" shows a code and polls. */
	flow?: "loopback" | "device";
	/** Microsoft needs a tenant for its endpoints. */
	tenant?: string;
	authUrl?: string;
	tokenUrl?: string;
	deviceAuthUrl?: string;
	redirectPort?: number;
}

export interface AccessToken {
	accessToken: string;
	expiresAt: number;
}

interface CacheEntry extends AccessToken {
	refreshToken?: string;
	scopes: string[];
}

export interface TokenRequestContext {
	agentDir: string;
	/** Notify the user (TUI) or write to stderr (headless). Called with the consent URL and code. */
	prompt?: (message: string) => void;
	/** Open the user's browser. Tests disable it and hit the loopback server directly. */
	openBrowser?: (url: string) => void | Promise<void>;
	/** Skip the cache and the `token` shortcut. */
	forceRefresh?: boolean;
}

const CACHE_FILE_NAME = "work-oauth.json";
/** Refresh this early so a token never expires between the request and the provider's check. */
const EXPIRY_SKEW_MS = 60_000;

interface ProviderEndpoints {
	authUrl: string;
	tokenUrl: string;
	deviceAuthUrl: string;
}

export function providerEndpoints(auth: WorkAuthConfig): ProviderEndpoints {
	if (auth.provider === "microsoft") {
		const tenant = auth.tenant || process.env.AZURE_TENANT_ID || "common";
		const base = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0`;
		return {
			authUrl: auth.authUrl ?? `${base}/authorize`,
			tokenUrl: auth.tokenUrl ?? `${base}/token`,
			deviceAuthUrl: auth.deviceAuthUrl ?? `${base}/devicecode`,
		};
	}
	return {
		authUrl: auth.authUrl ?? "https://accounts.google.com/o/oauth2/v2/auth",
		tokenUrl: auth.tokenUrl ?? "https://oauth2.googleapis.com/token",
		deviceAuthUrl: auth.deviceAuthUrl ?? "https://oauth2.googleapis.com/device/code",
	};
}

const CLIENT_ID_ENV: Record<OAuthProvider, string> = { google: "GOOGLE_CLIENT_ID", microsoft: "AZURE_CLIENT_ID" };
const CLIENT_SECRET_ENV: Record<OAuthProvider, string> = {
	google: "GOOGLE_CLIENT_SECRET",
	microsoft: "AZURE_CLIENT_SECRET",
};

/**
 * Read an `auth` object from `work.json`. The client id and secret fall back to the environment
 * because a connector file is committed to a repo while a client secret is not.
 */
export function parseAuthConfig(raw: unknown): { auth: WorkAuthConfig } | { error: string } {
	if (raw === undefined) return { error: "auth is required" };
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { error: "auth must be an object" };
	const record = raw as Record<string, unknown>;
	const provider = record.provider;
	if (provider !== "google" && provider !== "microsoft") {
		return { error: `auth.provider must be "google" or "microsoft", got ${JSON.stringify(provider)}` };
	}
	if (
		!Array.isArray(record.scopes) ||
		record.scopes.length === 0 ||
		record.scopes.some((scope) => typeof scope !== "string")
	) {
		return { error: `auth.scopes must be a non-empty array of strings` };
	}
	const stringField = (name: string): string | undefined =>
		typeof record[name] === "string" && record[name] !== "" ? (record[name] as string) : undefined;
	const auth: WorkAuthConfig = {
		provider,
		scopes: (record.scopes as string[]).map((scope) => scope.trim()).filter((scope) => scope.length > 0),
		clientId: stringField("clientId") ?? process.env[CLIENT_ID_ENV[provider]],
		clientSecret: stringField("clientSecret") ?? process.env[CLIENT_SECRET_ENV[provider]],
		token: stringField("token"),
		flow: record.flow === "device" ? "device" : record.flow === "loopback" ? "loopback" : undefined,
		tenant: stringField("tenant"),
		authUrl: stringField("authUrl"),
		tokenUrl: stringField("tokenUrl"),
		deviceAuthUrl: stringField("deviceAuthUrl"),
		redirectPort: typeof record.redirectPort === "number" ? record.redirectPort : undefined,
	};
	if (auth.scopes.length === 0) return { error: "auth.scopes contains only empty strings" };
	return { auth };
}

/** Run a `!command` config value or read an env var, without caching surprises. */
export function resolveTokenConfigValue(value: string): string | undefined {
	return resolveConfigValue(value);
}

function base64url(buffer: Buffer): string {
	return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** RFC 7636 PKCE pair. Public clients (no secret) need this to use the loopback flow. */
export function createPkce(): { verifier: string; challenge: string; method: "S256" } {
	const verifier = base64url(randomBytes(32));
	const challenge = base64url(createHash("sha256").update(verifier).digest());
	return { verifier, challenge, method: "S256" };
}

/** The consent URL. `challenge` is the PKCE code challenge; loopback flows always send one. */
export function buildAuthorizeUrl(
	auth: WorkAuthConfig,
	params: { state: string; redirectUri?: string; challenge?: string },
): string {
	const endpoints = providerEndpoints(auth);
	const query = new URLSearchParams({
		client_id: auth.clientId ?? "",
		response_type: "code",
		scope: auth.scopes.join(" "),
		state: params.state,
	});
	if (auth.provider === "microsoft") query.set("prompt", "select_account");
	if (params.redirectUri) {
		query.set("redirect_uri", params.redirectUri);
		if (params.challenge) {
			query.set("code_challenge", params.challenge);
			query.set("code_challenge_method", "S256");
		}
	}
	return `${endpoints.authUrl}?${query.toString()}`;
}

export function loopbackRedirectUri(port: number): string {
	return `http://localhost:${port}/callback`;
}

async function postForm(
	url: string,
	fields: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
	const response = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(fields).toString(),
	});
	const text = await response.text();
	let body: Record<string, unknown> = {};
	try {
		const parsed = JSON.parse(text) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
	} catch {
		body = { error_description: text.slice(0, 400) };
	}
	return { status: response.status, body };
}

function tokensFrom(body: Record<string, unknown>): { access: AccessToken; refreshToken?: string } | undefined {
	const accessToken = body.access_token;
	if (typeof accessToken !== "string" || accessToken.length === 0) return undefined;
	const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 3600;
	const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : undefined;
	return {
		access: { accessToken, expiresAt: Date.now() + expiresIn * 1000 },
		refreshToken,
	};
}

export function describeTokenError(body: Record<string, unknown>): string {
	const code = typeof body.error === "string" ? body.error : "oauth_error";
	const description = typeof body.error_description === "string" ? `: ${body.error_description}` : "";
	return `${code}${description}`;
}

// ---------------------------------------------------------------------------
// Token cache
// ---------------------------------------------------------------------------

type CacheFile = Record<string, CacheEntry>;

function cachePath(agentDir: string): string {
	return join(agentDir, CACHE_FILE_NAME);
}

function readCache(agentDir: string): CacheFile {
	const path = cachePath(agentDir);
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return parsed as CacheFile;
	} catch {
		return {};
	}
}

/** 0600: this file holds refresh tokens, which are as good as a password. */
export function writeCache(agentDir: string, cache: CacheFile): void {
	const path = cachePath(agentDir);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(cache, null, 2), { mode: 0o600 });
}

export function cacheKey(auth: WorkAuthConfig): string {
	return `${auth.provider}:${auth.scopes.slice().sort().join(" ")}`;
}

export function cachedToken(
	agentDir: string,
	auth: WorkAuthConfig,
): { access: AccessToken; refresh?: string } | undefined {
	const entry = readCache(agentDir)[cacheKey(auth)];
	if (!entry || typeof entry.accessToken !== "string") return undefined;
	return { access: { accessToken: entry.accessToken, expiresAt: entry.expiresAt }, refresh: entry.refreshToken };
}

export function storeToken(agentDir: string, auth: WorkAuthConfig, access: AccessToken, refreshToken?: string): void {
	const cache = readCache(agentDir);
	const previous = cache[cacheKey(auth)];
	cache[cacheKey(auth)] = {
		accessToken: access.accessToken,
		expiresAt: access.expiresAt,
		// A refresh response often omits the refresh token; keep the one we already have.
		refreshToken: refreshToken ?? previous?.refreshToken,
		scopes: auth.scopes,
	};
	writeCache(agentDir, cache);
}

export function clearToken(agentDir: string, auth: WorkAuthConfig): boolean {
	const cache = readCache(agentDir);
	const key = cacheKey(auth);
	if (!(key in cache)) return false;
	delete cache[key];
	writeCache(agentDir, cache);
	return true;
}

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------

export async function refreshAccessToken(
	auth: WorkAuthConfig,
	refreshToken: string,
): Promise<{ access: AccessToken; refreshToken?: string } | { error: string }> {
	const endpoints = providerEndpoints(auth);
	const fields: Record<string, string> = {
		grant_type: "refresh_token",
		refresh_token: refreshToken,
		client_id: auth.clientId ?? "",
	};
	if (auth.clientSecret) fields.client_secret = auth.clientSecret;
	const response = await postForm(endpoints.tokenUrl, fields);
	if (response.status >= 400) return { error: describeTokenError(response.body) };
	const tokens = tokensFrom(response.body);
	return tokens ?? { error: describeTokenError(response.body) };
}

export async function exchangeCodeForTokens(
	auth: WorkAuthConfig,
	code: string,
	verifier: string,
	/** Must match the authorize request byte for byte, so callers pass the final form. */
	redirectUri: string,
): Promise<{ access: AccessToken; refreshToken?: string } | { error: string }> {
	const endpoints = providerEndpoints(auth);
	const fields: Record<string, string> = {
		grant_type: "authorization_code",
		code,
		client_id: auth.clientId ?? "",
		code_verifier: verifier,
	};
	if (redirectUri) fields.redirect_uri = redirectUri;
	if (auth.clientSecret) fields.client_secret = auth.clientSecret;
	const response = await postForm(endpoints.tokenUrl, fields);
	if (response.status >= 400) return { error: describeTokenError(response.body) };
	const tokens = tokensFrom(response.body);
	return tokens ?? { error: describeTokenError(response.body) };
}

/** Catch the authorization code on a loopback redirect. Returns the code, or an error. */
/**
 * Catch the authorization code on a loopback redirect. The PKCE verifier and the state it issued are
 * returned with the code, because both must match the exchange that follows.
 */
export function waitForAuthorizationCode(
	auth: WorkAuthConfig,
	options: {
		port: number;
		openBrowser?: (url: string) => void | Promise<void>;
		prompt?: (message: string) => void;
		timeoutMs?: number;
	},
): Promise<{ code: string; state: string; verifier: string; redirectUri: string } | { error: string }> {
	const port = options.port;
	const timeoutMs = options.timeoutMs ?? 300_000;
	return new Promise((resolve) => {
		const server = createServer((request, response) => {
			const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
			if (url.pathname !== "/callback") {
				response.writeHead(404).end();
				return;
			}
			const code = url.searchParams.get("code");
			const state = url.searchParams.get("state") ?? "";
			const failure = url.searchParams.get("error");
			response.writeHead(200, { "content-type": "text/plain" });
			response.end(failure ? `Sign-in failed: ${failure}. Close this tab.` : "Signed in. Close this tab.");
			server.close();
			if (failure) resolve({ error: `authorization denied: ${failure}` });
			else if (!code) resolve({ error: "authorization response carried no code" });
			else if (state !== expectedState)
				resolve({ error: "state mismatch: the sign-in response did not match this request" });
			else resolve({ code, state, verifier: pkce.verifier, redirectUri: `http://localhost:${port}/callback` });
		});
		server.on("error", (error) => resolve({ error: `could not listen on port ${port}: ${error.message}` }));
		const pkce = createPkce();
		const state = base64url(randomBytes(12));
		const expectedState = state;
		server.listen(port, "127.0.0.1", async () => {
			const url = buildAuthorizeUrl(auth, {
				state,
				redirectUri: `http://localhost:${port}/callback`,
				challenge: pkce.challenge,
			});
			options.prompt?.(`Open this URL to sign in:\n${url}`);
			if (options.openBrowser) await options.openBrowser(url);
		});
		const timer = setTimeout(() => {
			server.close();
			resolve({ error: "timed out waiting for the browser to return to the sign-in URL" });
		}, timeoutMs);
		timer.unref?.();
	});
}

interface DeviceAuthorizationResponse {
	device_code?: string;
	user_code?: string;
	verification_url?: string;
	interval?: number;
	expires_in?: number;
}

export function parseDeviceAuthorization(
	body: Record<string, unknown>,
): { ok: true; device: DeviceAuthorizationResponse } | { ok: false; error: string } {
	const device = body as DeviceAuthorizationResponse;
	if (typeof device.device_code !== "string" || typeof device.verification_url !== "string") {
		return { ok: false, error: describeTokenError(body) };
	}
	return {
		ok: true,
		device: {
			...device,
			interval: typeof device.interval === "number" ? device.interval : 5,
			expires_in: typeof device.expires_in === "number" ? device.expires_in : 900,
		},
	};
}

/**
 * Device flow: the provider hands us a code the user types into a URL we print. No localhost port,
 * so it works over SSH and in a container.
 */
export async function authorizeWithDeviceFlow(
	auth: WorkAuthConfig,
	context: { prompt?: (message: string) => void; sleep?: (ms: number) => Promise<void> },
): Promise<{ access: AccessToken; refreshToken?: string } | { error: string }> {
	if (!auth.clientId) return { error: `${auth.provider} device flow needs a client id` };
	const endpoints = providerEndpoints(auth);
	const scopes = auth.scopes.join(" ");
	const initial = await postForm(endpoints.deviceAuthUrl, {
		client_id: auth.clientId,
		scope: scopes,
		...(auth.clientSecret ? { client_secret: auth.clientSecret } : {}),
	});
	const parsed = parseDeviceAuthorization(initial.body);
	if (!parsed.ok) return { error: `device authorization failed: ${parsed.error}` };
	const { device } = parsed;
	const userCode = typeof device.user_code === "string" ? device.user_code : "";
	context.prompt?.(
		`Sign in at ${device.verification_url}${userCode ? ` and enter the code ${userCode}` : ""}. ` +
			`This request waits up to ${Math.round((device.expires_in ?? 900) / 60)} minute(s).`,
	);

	const sleep = context.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.()));
	const deadline = Date.now() + (device.expires_in ?? 900) * 1000;
	const intervalMs = Math.max(1, device.interval ?? 5) * 1000;
	while (Date.now() < deadline) {
		await sleep(intervalMs);
		const poll = await postForm(endpoints.tokenUrl, {
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			device_code: device.device_code ?? "",
			client_id: auth.clientId,
		});
		const tokens = tokensFrom(poll.body);
		if (tokens) return tokens;
		const error = typeof poll.body.error === "string" ? poll.body.error : "";
		if (error === "authorization_pending" || error === "slow_down") continue;
		return { error: describeTokenError(poll.body) };
	}
	return { error: "the sign-in code expired before it was approved" };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface AccessTokenResult {
	accessToken: string;
	source: "config" | "cache" | "refresh" | "loopback" | "device";
}

/**
 * Resolve a usable access token for `auth`, caching and refreshing as needed.
 * `cwd` is only used to run a `token` command.
 */
export async function getAccessToken(
	auth: WorkAuthConfig,
	context: TokenRequestContext & { cwd: string },
): Promise<{ result: AccessTokenResult } | { error: string }> {
	if (!Array.isArray(auth.scopes) || auth.scopes.length === 0) {
		return { error: `${auth.provider} auth needs at least one scope` };
	}

	if (auth.token && !context.forceRefresh) {
		const resolved = resolveTokenConfigValue(auth.token);
		if (resolved === undefined) return { error: `auth.token "${auth.token}" did not resolve` };
		return { result: { accessToken: resolved, source: "config" } };
	}

	if (!context.forceRefresh) {
		const cached = cachedToken(context.agentDir, auth);
		if (cached && cached.access.expiresAt - EXPIRY_SKEW_MS > Date.now()) {
			return { result: { accessToken: cached.access.accessToken, source: "cache" } };
		}
		if (cached?.refresh) {
			const refreshed = await refreshAccessToken(auth, cached.refresh);
			if ("access" in refreshed) {
				storeToken(context.agentDir, auth, refreshed.access, refreshed.refreshToken);
				return { result: { accessToken: refreshed.access.accessToken, source: "refresh" } };
			}
			// A revoked or rotated refresh token means consent again, not a hard failure.
			clearToken(context.agentDir, auth);
		}
	}

	if (!auth.clientId) {
		return {
			error:
				`no token for ${auth.provider} and no client id configured. Set ${auth.provider === "microsoft" ? "AZURE_CLIENT_ID" : "GOOGLE_CLIENT_ID"}, ` +
				`or point auth.token at a command such as "!gcloud auth print-access-token".`,
		};
	}

	const endpoints = providerEndpoints(auth);
	if (auth.flow === "device") {
		const device = await authorizeWithDeviceFlow({ ...auth, ...endpoints }, { prompt: context.prompt });
		if ("error" in device) return { error: device.error };
		storeToken(context.agentDir, auth, device.access, device.refreshToken);
		return { result: { accessToken: device.access.accessToken, source: "device" } };
	}

	const port = auth.redirectPort ?? 8743;
	const redirectUri = loopbackRedirectUri(port);
	const scopedAuth: WorkAuthConfig = { ...auth, ...endpoints, redirectPort: port };
	const callback = await waitForAuthorizationCode(scopedAuth, {
		port,
		openBrowser: context.openBrowser,
		prompt: context.prompt,
	});
	if ("error" in callback) return { error: callback.error };

	const exchanged = await exchangeCodeForTokens(scopedAuth, callback.code, callback.verifier, redirectUri);
	if ("error" in exchanged) return { error: exchanged.error };
	storeToken(context.agentDir, auth, exchanged.access, exchanged.refreshToken);
	return { result: { accessToken: exchanged.access.accessToken, source: "loopback" } };
}
