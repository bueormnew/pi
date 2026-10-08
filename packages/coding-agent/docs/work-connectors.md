# Work Connectors

`work` turns local CLIs and internal HTTP APIs into typed tools. Instead of asking the model to
guess shell flags, you declare each capability once and the model calls `gmail_search({ query })`.

Connector definitions live in `work.json`, read from both `~/.pi/agent/work.json` (global) and
`<project>/.pi/work.json` (project). The project file wins when a tool name matches. Nothing is
fetched and no network is involved unless a connector you wrote does that.

## A connector

```json
{
  "connectors": {
    "gmail": {
      "commands": {
        "search": {
          "description": "Search Gmail messages with a Gmail query, e.g. from:dana is:unread",
          "argv": ["gog", "gmail", "search", "{{query}}", "--max", "{{max:15}}"],
          "params": {
            "query": { "type": "string", "description": "Gmail search query" },
            "max": { "type": "number", "description": "Maximum messages", "default": 15 }
          },
          "readOnly": true
        },
        "send": {
          "description": "Send one email. Say what you are about to send before calling this.",
          "argv": ["gog", "gmail", "send", "--to", "{{to}}", "--subject", "{{subject}}", "--body-file", "{{body_file}}"],
          "params": {
            "to": { "type": "string" },
            "subject": { "type": "string" },
            "body_file": { "type": "string", "description": "Path to a file holding the message body" }
          }
        }
      }
    }
  }
}
```

Each entry under `connectors.<name>.commands.<name>` becomes one tool named
`<connector>_<command>` (non-alphanumeric characters become `_`). `description` is required: it is
the only thing the model reads about the tool.

## Command connectors

| Field | Meaning |
|-------|---------|
| `argv` | Executable and arguments. Run directly, no shell, so `&&`, pipes and globs do not work. |
| `params` | `string`, `number` or `boolean`. Each may set `description`, `default`, `required: false`. |
| `readOnly` | Sets the tool's `readOnlyHint`, which permission-style extensions can act on. |
| `timeoutMs` | Kills the process after this long. Default 60000. |

`{{name}}` is replaced by the model's argument; `{{name:default}}` carries a fallback. A placeholder
with no value and no default is a tool error, not a silently empty argument. A value containing a
newline is rejected. Output is truncated at 20 KB; a non-zero exit code marks the result as an error
and is reported alongside stderr.

## HTTP connectors

Set `"kind": "http"` with `url`, optional `method` (default `GET`), `headers` and `body`. All four
accept `{{param}}` templates, so a search endpoint and a POST RPC both fit:

```json
{
  "connectors": {
    "runbook": {
      "commands": {
        "search": {
          "description": "Search the internal runbook index",
          "kind": "http",
          "method": "POST",
          "url": "https://runbook.internal/api/search",
          "headers": { "authorization": "$RUNBOOK_TOKEN" },
          "body": "{\"q\":\"{{query}}\"}",
          "params": { "query": { "type": "string" } },
          "readOnly": true
        }
      }
    }
  }
}
```

## Built-in connectors for Google and Microsoft

`src/extensions/work/presets.ts` ships six connectors — `gmail`, `drive`, `docs`, `sheets`,
`calendar`, `graph` — as ordinary `work.json` fragments in code, so they are parsed and validated by
the same rules as yours and a project file with the same tool name replaces them.

They load only when their credentials are reachable: an access token in `GOOGLE_ACCESS_TOKEN` /
`AZURE_ACCESS_TOKEN`, or an OAuth client id in `GOOGLE_CLIENT_ID` / `AZURE_CLIENT_ID`, or a token
already cached from a previous sign-in. Otherwise they stay off, because a tool that fails on every
call is worse than no tool, and `/work` prints the exact thing to set instead of guessing for you.

With a client id and no token, the first call signs you in: a browser opens the provider's consent
screen and a loopback server on `localhost:8743` catches the code (RFC 7636 PKCE, so no client secret
in the file), or `"flow": "device"` prints a code to type at the provider's verification URL, which is
the one that works over SSH. Tokens live in `<agentDir>/work-oauth.json` with mode `0600` and are
refreshed 60 seconds before they expire.

| Connector | Tools | Scopes |
|-----------|-------|--------|
| `gmail` | `gmail_search`, `gmail_read`, `gmail_send` | `gmail.readonly`, `gmail.send` |
| `drive` | `drive_find`, `drive_read_text` | `drive.readonly` |
| `docs` | `docs_read`, `docs_append` | `documents` |
| `sheets` | `sheets_read`, `sheets_append` | `spreadsheets` |
| `calendar` | `calendar_events` | `calendar.readonly` |
| `graph` | `graph_find`, `graph_read_text`, `graph_word_read`, `graph_word_append`, `graph_mail_list`, `graph_mail_send` | `Files.Read`, `Files.ReadWrite`, `Mail.Read`, `Mail.Send` |

Word is paragraph-level over the Graph Word API on purpose: read a document and append a paragraph work
remotely, while layout, styles and tracked changes need the `.docx` open locally — and work mode keeps
`read`/`edit`/`write`, so that is the same session. Docs is the same trade: `docs_append` never rewrites
what is there, because the API has no "replace this sentence" verb that is safe to hand a model.

## Secrets

`argv`, `url`, `headers` and `body` accept the same config-value syntax as the rest of pi's
configuration: `$NAME` or `${NAME}` reads an environment variable, and a leading `!` runs a command
and uses its stdout (`"!opread token"`). Secrets resolve **before** model-supplied values are
substituted, so a tool argument that happens to contain `$HOME` stays literal and cannot reach your
environment.

Put secrets in the environment or a command, never in `work.json`: a project file is repo-controlled
and gets read by anyone who clones it.

## Templates

`argv`, `url`, `headers`, `body`, `compose.template` and every step accept `{{name}}` and
`{{name:default}}`. A value is escaped for the place it lands in, because each of them breaks
differently:

| Target | Escaping |
|--------|----------|
| `url` | percent-encoded, so `name contains 'x' and 'y'` survives as a query string. The template's own `://`, `?` and `&` are untouched |
| `body` | JSON string escaping, so a quote or newline in the model's text cannot end the string early |
| `headers` | none, and CR or LF is refused outright — that is header injection |
| `argv` | none, and a newline is refused; each element stays one argument |

`{{+name}}` inserts the value verbatim. It exists for one case: a JSON fragment the model wrote, such
as a spreadsheet row, which must not be quote-escaped — `"values":[[{{+row}}]]` with `row` set to
`"Q3", 1200` produces valid JSON. It is not for secrets.

## Building a payload

`compose` produces one extra value from a template before anything renders, which is how an API that
wants an encoded document rather than JSON gets one:

```json
{
  "connectors": {
    "gmail": {
      "commands": {
        "send": {
          "description": "Send a plain-text email",
          "kind": "http",
          "method": "POST",
          "url": "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
          "body": "{\"raw\":\"{{raw}}\"}",
          "compose": {
            "field": "raw",
            "template": "To: {{to}}\r\nSubject: {{subject}}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=\"UTF-8\"\r\n\r\n{{body}}",
            "encode": "b64url"
          },
          "params": { "to": { "type": "string" }, "subject": { "type": "string" }, "body": { "type": "string" } },
          "readOnly": false
        }
      }
    }
  }
}
```

Gmail's send endpoint takes an RFC 2822 message, base64url-encoded. Without `compose` the model would
have to produce that encoding itself, and a model writing base64 in a tool argument is a corruption it
will not notice.

## Sequences

Some resources have no single-call verb. `steps` runs requests in order and lets a later one read values
out of an earlier response:

```json
{
  "steps": [
  { "url": "https://www.googleapis.com/drive/v3/files?q={{query}}", "capture": { "fileId": "files.0.id" } },
    { "url": "https://www.googleapis.com/drive/v3/files/{{fileId}}/permissions", "method": "POST", "body": "{\"role\":\"reader\"}" }
  ]
}
```

A capture path is dotted, with numbers for array indices; nothing else, because a query language inside
a config file is a second program. If a path finds nothing, the command stops with `capture path
"files.0.id" found nothing` rather than sending a second request built from an empty value.

## Commands

- `/work` lists the loaded connectors, their tools, every parse error with its file, and what to set to
  turn on a built-in connector that is off.
- `/work reload` re-reads both files and registers tools that appeared. Changed definitions of an
  already registered tool need a restart, since a running session keeps its registration.

## What this is not

`work` is not a permission layer. It executes exactly what you declared, with the permissions of the
pi process, and any `readOnly` flag is a claim by the config author rather than a verified property.
To restrict what a connector may touch, run pi in a container or sandbox
([containerization.md](containerization.md)), or add an extension that blocks tool calls
([extensions.md](extensions.md)).

Mode gating is a separate layer and composes with this: in `plan` mode only connector commands that
declare `readOnly` are available, `work` mode keeps every connector tool plus local document editing and
has no shell, and `code` mode is unrestricted
([LITE.md](../../../LITE.md)). A connector does not know which mode called it.

For MCP servers, keep using `/mcp`: it has its own transport, auth and tool discovery. Use `work`
for what MCP does not cover: the CLIs already on your machine and the plain HTTP endpoints you run
internally.
