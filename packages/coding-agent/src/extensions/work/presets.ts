/**
 * Built-in work connectors for Google Workspace and Microsoft 365.
 *
 * These are ordinary `work.json` fragments in code, so they go through the same parser, the same
 * validation and the same `auth` path as a hand-written connector — a preset is not a special case
 * with private privileges.
 *
 * Two deliberate choices:
 *
 * - Endpoints are the public REST APIs, not a CLI wrapper. Gmail, Docs, Sheets, Drive, Calendar and
 *   Graph all expose the resource URLs below, so a connector keeps working when no vendor CLI is
 *   installed, and `readOnly` matches the HTTP verb rather than a CLI's mood.
 * - A preset is only offered when its credentials are reachable. Enabling "gmail" and then failing on
 *   every call is worse than staying silent until a client id (or an access token) exists.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { OAuthProvider } from "./oauth.ts";

const GMAIL_SCOPE_READONLY = "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL_SCOPE_SEND = "https://www.googleapis.com/auth/gmail.send";
const DRIVE_SCOPE_READONLY = "https://www.googleapis.com/auth/drive.readonly";
const DOCS_SCOPE = "https://www.googleapis.com/auth/documents";
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const CALENDAR_SCOPE_READONLY = "https://www.googleapis.com/auth/calendar.readonly";

export interface WorkPreset {
	/** Connector name as it appears in tool names, e.g. `gmail_search`. */
	name: string;
	provider: OAuthProvider;
	blurb: string;
	/** Env var that makes this preset usable without any setup besides exporting it. */
	tokenEnvVar?: string;
	clientIdEnvVar: string;
	commands: Record<string, Record<string, unknown>>;
}

const googleAuth = (scopes: string[], tokenEnvVar: string) => ({
	provider: "google",
	scopes,
	// `!gcloud auth print-access-token` also works here, but only for GCP APIs — Gmail needs a real
	// OAuth client with the mail scope, so the env var is the honest default.
	token: `$${tokenEnvVar}`,
});

const microsoftAuth = (scopes: string[], tokenEnvVar: string) => ({
	provider: "microsoft",
	scopes,
	token: `$${tokenEnvVar}`,
});

export const LITE_WORK_PRESETS: WorkPreset[] = [
	{
		name: "gmail",
		provider: "google",
		blurb: "search, read and send Gmail messages",
		tokenEnvVar: "GOOGLE_ACCESS_TOKEN",
		clientIdEnvVar: "GOOGLE_CLIENT_ID",
		commands: {
			search: {
				description: "Search Gmail with a Gmail query (e.g. from:ana@corp.com has:attachment newer_than:14d).",
				kind: "http",
				readOnly: true,
				method: "GET",
				url: "https://gmail.googleapis.com/gmail/v1/users/me/messages?q={{query}}&maxResults={{limit}}",
				auth: googleAuth([GMAIL_SCOPE_READONLY], "GOOGLE_ACCESS_TOKEN"),
				params: {
					query: { type: "string", description: "Gmail search syntax" },
					limit: { type: "number", description: "Maximum messages to return", default: 20 },
				},
			},
			read: {
				description: "Read one Gmail message by id, including headers and snippet.",
				kind: "http",
				readOnly: true,
				method: "GET",
				url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/{{id}}?format=full",
				auth: googleAuth([GMAIL_SCOPE_READONLY], "GOOGLE_ACCESS_TOKEN"),
				params: { id: { type: "string", description: "Message id from gmail_search" } },
			},
			send: {
				description: "Send a plain-text Gmail message. The message is composed here and sent as RFC 2822.",
				kind: "http",
				readOnly: false,
				method: "POST",
				url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
				headers: { "content-type": "application/json" },
				body: `{"raw":"{{raw}}"}`,
				compose: {
					field: "raw",
					template:
						'To: {{to}}\r\nSubject: {{subject}}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\n{{body}}',
					encode: "b64url",
				},
				auth: googleAuth([GMAIL_SCOPE_SEND], "GOOGLE_ACCESS_TOKEN"),
				params: {
					to: { type: "string", description: "Recipient address" },
					subject: { type: "string", description: "Subject line" },
					body: { type: "string", description: "Message body, plain text" },
				},
			},
		},
	},
	{
		name: "drive",
		provider: "google",
		blurb: "find Drive files and read their text content",
		tokenEnvVar: "GOOGLE_ACCESS_TOKEN",
		clientIdEnvVar: "GOOGLE_CLIENT_ID",
		commands: {
			find: {
				description:
					"Search Google Drive. Query uses Drive syntax, e.g. name contains 'runbook' and 'me' in owners.",
				kind: "http",
				readOnly: true,
				method: "GET",
				url: "https://www.googleapis.com/drive/v3/files?q={{query}}&pageSize={{limit}}&fields=files(id,name,mimeType,modifiedTime,owners)",
				auth: googleAuth([DRIVE_SCOPE_READONLY], "GOOGLE_ACCESS_TOKEN"),
				params: {
					query: { type: "string", description: "Drive q parameter" },
					limit: { type: "number", description: "Maximum files to return", default: 20 },
				},
			},
			read_text: {
				description:
					"Download a Drive file's bytes as text. Only useful for text files; use docs_read for Google Docs.",
				kind: "http",
				readOnly: true,
				method: "GET",
				url: "https://www.googleapis.com/drive/v3/files/{{id}}?alt=media",
				auth: googleAuth([DRIVE_SCOPE_READONLY], "GOOGLE_ACCESS_TOKEN"),
				params: { id: { type: "string", description: "Drive file id" } },
			},
		},
	},
	{
		name: "docs",
		provider: "google",
		blurb: "read a Google Doc and append text to it",
		tokenEnvVar: "GOOGLE_ACCESS_TOKEN",
		clientIdEnvVar: "GOOGLE_CLIENT_ID",
		commands: {
			read: {
				description: "Read a Google Doc as structured JSON (title plus body content).",
				kind: "http",
				readOnly: true,
				method: "GET",
				url: "https://docs.googleapis.com/v1/documents/{{document_id}}",
				auth: googleAuth([DOCS_SCOPE], "GOOGLE_ACCESS_TOKEN"),
				params: { document_id: { type: "string", description: "Document id from the /document/ URL" } },
			},
			append: {
				description: "Append text to the end of a Google Doc. Existing content is never rewritten.",
				kind: "http",
				readOnly: false,
				method: "POST",
				url: "https://docs.googleapis.com/v1/documents/{{document_id}}:batchUpdate",
				headers: { "content-type": "application/json" },
				body: `{"requests":[{"insertText":{"endOfSegmentLocation":{},"text":"{{text}}"}}]}`,
				auth: googleAuth([DOCS_SCOPE], "GOOGLE_ACCESS_TOKEN"),
				params: {
					document_id: { type: "string", description: "Document id" },
					text: { type: "string", description: "Text to append; \\n separates paragraphs" },
				},
			},
		},
	},
	{
		name: "sheets",
		provider: "google",
		blurb: "read a range and append a row to a Google Sheet",
		tokenEnvVar: "GOOGLE_ACCESS_TOKEN",
		clientIdEnvVar: "GOOGLE_CLIENT_ID",
		commands: {
			read: {
				description: "Read values from a Google Sheets range such as Sheet1!A1:D50.",
				kind: "http",
				readOnly: true,
				method: "GET",
				url: "https://sheets.googleapis.com/v4/spreadsheets/{{spreadsheet_id}}/values/{{range}}",
				auth: googleAuth([SHEETS_SCOPE], "GOOGLE_ACCESS_TOKEN"),
				params: {
					spreadsheet_id: { type: "string", description: "Spreadsheet id from the /spreadsheets/d/ URL" },
					range: { type: "string", description: "A1 range", default: "Sheet1" },
				},
			},
			append: {
				description: "Append one row to a Google Sheet. The row is a JSON array of cell values.",
				kind: "http",
				readOnly: false,
				method: "POST",
				url: "https://sheets.googleapis.com/v4/spreadsheets/{{spreadsheet_id}}/values/{{range}}:append?valueInputOption=USER_ENTERED",
				headers: { "content-type": "application/json" },
				body: `{"values":[[{{+row}}]]}`,
				auth: googleAuth([SHEETS_SCOPE], "GOOGLE_ACCESS_TOKEN"),
				params: {
					spreadsheet_id: { type: "string", description: "Spreadsheet id" },
					range: { type: "string", description: "Sheet name to append to", default: "Sheet1" },
					row: {
						type: "string",
						description: 'JSON array of cell values for one row, e.g. "Q3", 1200, true',
					},
				},
			},
		},
	},
	{
		name: "calendar",
		provider: "google",
		blurb: "list Google Calendar events in a window",
		tokenEnvVar: "GOOGLE_ACCESS_TOKEN",
		clientIdEnvVar: "GOOGLE_CLIENT_ID",
		commands: {
			events: {
				description: "List events in a Google Calendar between two RFC 3339 timestamps.",
				kind: "http",
				readOnly: true,
				method: "GET",
				url: "https://www.googleapis.com/calendar/v3/calendars/{{calendar}}/events?timeMin={{time_min}}&timeMax={{time_max}}&maxResults={{limit}}&singleEvents=true&orderBy=startTime",
				auth: googleAuth([CALENDAR_SCOPE_READONLY], "GOOGLE_ACCESS_TOKEN"),
				params: {
					calendar: { type: "string", description: "Calendar id", default: "primary" },
					time_min: { type: "string", description: "Start of window, e.g. 2026-10-08T00:00:00Z" },
					time_max: { type: "string", description: "End of window, exclusive" },
					limit: { type: "number", description: "Maximum events", default: 25 },
				},
			},
		},
	},
	{
		name: "graph",
		provider: "microsoft",
		blurb: "OneDrive search, Word paragraph append, Outlook mail read and send",
		tokenEnvVar: "AZURE_ACCESS_TOKEN",
		clientIdEnvVar: "AZURE_CLIENT_ID",
		commands: {
			find: {
				description: "Search your OneDrive for files by name.",
				kind: "http",
				readOnly: true,
				method: "GET",
				url: "https://graph.microsoft.com/v1.0/me/drive/root/search(q='{{query}}')/children?$top={{limit}}&$select=name,id,file,parentReference,lastModifiedDateTime",
				auth: microsoftAuth(["Files.Read"], "AZURE_ACCESS_TOKEN"),
				params: {
					query: { type: "string", description: "File name fragment" },
					limit: { type: "number", description: "Maximum items", default: 20 },
				},
			},
			read_text: {
				description: "Download a OneDrive file's content as text (text files only).",
				kind: "http",
				readOnly: true,
				method: "GET",
				url: "https://graph.microsoft.com/v1.0/me/drive/items/{{item_id}}/content",
				auth: microsoftAuth(["Files.Read"], "AZURE_ACCESS_TOKEN"),
				params: { item_id: { type: "string", description: "Drive item id" } },
			},
			word_read: {
				description: "Read a Word document in OneDrive through the Graph Word API (returns its body).",
				kind: "http",
				readOnly: true,
				method: "GET",
				url: "https://graph.microsoft.com/v1.0/me/drive/items/{{item_id}}/word/document",
				headers: { accept: "application/json" },
				auth: microsoftAuth(["Files.Read"], "AZURE_ACCESS_TOKEN"),
				params: { item_id: { type: "string", description: "Id of a .docx file in OneDrive" } },
			},
			word_append: {
				description: "Append a paragraph to a Word document in OneDrive. Layout edits belong in a local copy.",
				kind: "http",
				readOnly: false,
				method: "POST",
				url: "https://graph.microsoft.com/v1.0/me/drive/items/{{item_id}}/word/document/body/paragraphs",
				headers: { "content-type": "application/json" },
				body: `{"text":"{{text}}"}`,
				auth: microsoftAuth(["Files.ReadWrite"], "AZURE_ACCESS_TOKEN"),
				params: {
					item_id: { type: "string", description: "Id of a .docx file in OneDrive" },
					text: { type: "string", description: "Paragraph text to add at the end" },
				},
			},
			mail_list: {
				description: "List your most recent Outlook messages with a preview of each.",
				kind: "http",
				readOnly: true,
				method: "GET",
				url: "https://graph.microsoft.com/v1.0/me/messages?$top={{limit}}&$orderby=receivedDateTime desc&$select=subject,from,receivedDateTime,bodyPreview",
				auth: microsoftAuth(["Mail.Read"], "AZURE_ACCESS_TOKEN"),
				params: { limit: { type: "number", description: "Maximum messages", default: 20 } },
			},
			mail_send: {
				description: "Send an Outlook mail as plain text.",
				kind: "http",
				readOnly: false,
				method: "POST",
				url: "https://graph.microsoft.com/v1.0/me/sendMail",
				headers: { "content-type": "application/json" },
				body: `{"message":{"subject":"{{subject}}","body":{"contentType":"text","content":"{{body}}"},"toRecipients":[{"emailAddress":{"address":"{{to}}"}}]}}`,
				auth: microsoftAuth(["Mail.Send"], "AZURE_ACCESS_TOKEN"),
				params: {
					to: { type: "string", description: "Recipient address" },
					subject: { type: "string", description: "Subject line" },
					body: { type: "string", description: "Message body, plain text" },
				},
			},
		},
	},
];

function hasCachedToken(agentDir: string, provider: OAuthProvider): boolean {
	const path = join(agentDir, "work-oauth.json");
	if (!existsSync(path)) return false;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
		return Object.keys(parsed as Record<string, unknown>).some((key) => key.startsWith(`${provider}:`));
	} catch {
		return false;
	}
}

/** A preset is usable when a token is already in the environment or an OAuth client id is set. */
export function isPresetUsable(preset: WorkPreset, agentDir: string, env: NodeJS.ProcessEnv = process.env): boolean {
	if (preset.tokenEnvVar && env[preset.tokenEnvVar]) return true;
	if (env[preset.clientIdEnvVar]) return true;
	return hasCachedToken(agentDir, preset.provider);
}

export interface PresetScan {
	enabled: WorkPreset[];
	disabled: WorkPreset[];
}

export function scanPresets(agentDir: string, env: NodeJS.ProcessEnv = process.env): PresetScan {
	const enabled: WorkPreset[] = [];
	const disabled: WorkPreset[] = [];
	for (const preset of LITE_WORK_PRESETS) {
		if (isPresetUsable(preset, agentDir, env)) enabled.push(preset);
		else disabled.push(preset);
	}
	return { enabled, disabled };
}

export function presetWorkConfigFragment(
	agentDir: string,
	env: NodeJS.ProcessEnv = process.env,
): {
	connectors: Record<string, unknown>;
	enabled: string[];
	disabled: WorkPreset[];
} {
	const scan = scanPresets(agentDir, env);
	const connectors: Record<string, unknown> = {};
	for (const preset of scan.enabled) connectors[preset.name] = { commands: preset.commands };
	return { connectors, enabled: scan.enabled.map((preset) => preset.name), disabled: scan.disabled };
}

/** How to turn on a preset that is off — shown by `/work`, never silently swallowed. */
export function enableHint(preset: WorkPreset): string {
	const flow =
		preset.provider === "google"
			? "an OAuth client from the Google Cloud console (consent screen type: External)"
			: "an app registration in Entra ID (redirect URI http://localhost:8743/callback, public client)";
	return `  - ${preset.name}: ${preset.blurb}. Turn on with either ${preset.tokenEnvVar}=<access token> (no consent flow needed) or ${preset.clientIdEnvVar}=<client id>, which fetches a token by opening a browser the first time you call it. Needs ${flow}. Then: /work reload`;
}
