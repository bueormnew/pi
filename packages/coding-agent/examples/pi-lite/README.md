# pi-lite configuration examples

Three files, three destinations. The global ones apply everywhere; the project ones win per key.

| Example | Global destination | Project destination |
|---------|--------------------|---------------------|
| `models.json` | `~/.pi/agent/models.json` | — (models are machine-level, not per repo) |
| `lite.json`   | `~/.pi/agent/lite.json`     | `<repo>/.pi/lite.json` |
| `work.json`   | `~/.pi/agent/work.json`     | `<repo>/.pi/work.json` |

`PI_CODING_AGENT_DIR` moves the global directory if you want the fork's state kept apart from a `pi`
you already use: `export PI_CODING_AGENT_DIR=~/pi-lite-agent`.

## models.json

Each entry under `providers` is one endpoint: `baseUrl`, `api` (`openai-completions`,
`anthropic-messages`, `google-generative-ai`), and the model ids that endpoint serves. This is how local
and self-hosted models are added — Ollama, LM Studio, vLLM, SGLang, an internal proxy. `apiKey` and
`headers` accept `$NAME`, `${NAME}` and `!command` (a command whose stdout is the secret; the example
uses macOS `security`, so switch it to your own secret store, or delete the line).

Nothing here replaces a built-in provider: if the catalog already knows `anthropic`, keep using it and
just provide `ANTHROPIC_API_KEY` or run `/login anthropic`. Use `models.json` for what pi does not
already include. Opening `/model` reloads the file, so there is no restart loop while you tune it.

## lite.json

The pi-lite modes file. `mode` is the default at start-up and `models` picks a model per mode, so plan
can run on the strongest model you can reach and work on a cheap local one. `/mode` prints what is
active; `--lite-mode work` overrides for one session.

## work.json

Work connectors. `"kind": "command"` runs a direct `argv` with no shell, so it needs a CLI on `PATH`;
`"kind": "http"` calls an endpoint. `readOnly: true` is what keeps a tool available in plan mode, and a
connector's write tools are the ones work mode announces before sending.

Gmail, Drive, Docs, Sheets, Calendar and Microsoft Graph are already defined in code and load themselves
when their credentials exist, so `gmail_local` above is only the pattern for a machine where a vendor CLI
already holds a token. `/work` lists what is loaded and what to set for what is not.
