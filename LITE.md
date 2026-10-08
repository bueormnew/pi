# pi-lite

A fork of [pi](https://github.com/earendil-works/pi) trimmed to a personal agent harness: no
third-party network calls at startup, no legacy migrations, and three capabilities upstream keeps out
of core — plan mode, sub-agents, and connector-driven work against local tools.

This file is the fork's own contract. Upstream docs stay under
[`packages/coding-agent/docs`](packages/coding-agent/docs).

## What changed here

### Offline is the default

`main.ts` used to treat network as the default and `--offline` as the exception. It is inverted now:

```ts
const offlineMode = !args.includes("--online") && !isTruthyEnvFlag(process.env.PI_ALLOW_NETWORK);
```

So a cold start touches no pi.dev model catalog, no version endpoint, no npm registry. `--online` (or
`PI_ALLOW_NETWORK=1`) opts back in for catalog refresh and package update checks. `--offline` and
`PI_OFFLINE` still parse, for scripts that pass them.

The two startup network calls in interactive mode (`checkForNewPiVersion`, `checkForPackageUpdates`)
and their notification renderers are deleted, not gated. `utils/version-check.ts` remains because
`pi update` needs it explicitly.

Consequence worth knowing: `packages/ai` ships `models.generated.ts` as a stub that is hydrated from
pi.dev into the gitignored `packages/ai/src/providers/data/`. Offline, that directory is the source of
truth, and `models.json` (see [models.md](packages/coding-agent/docs/models.md)) is how you add a
model. For an offline-first fork that is the right shape, but it means a fresh checkout needs one
hydrated copy of that data to typecheck and to run the model-catalog-dependent tests.

### Legacy migrations are gone

`packages/coding-agent/src/migrations.ts` ran on every startup and existed to move people off
pi versions from 2025: `oauth.json` into `auth.json`, `commands/` into `prompts/`, `hooks/` and
`tools/` into `extensions/`, sessions misplaced by the v0.30.0 bug, `fd`/`rg` from `tools/` into
`bin/`. Deleting it also removes the blocking "press any key to continue" prompt on startup.

The normalization that migration performed is not lost: `keybindings.json` and `settings.json` are
migrated on **read** (`KeybindingsManager.loadFromFile`, `SettingsManager.migrateSettings`), so old
config keeps working and the files stay untouched until the user saves them. The migration-only tests
were retargeted at the read path rather than deleted.

### Four built-in extensions

Registered in [`packages/coding-agent/src/extensions/index.ts`](packages/coding-agent/src/extensions/index.ts)
next to codemode, tool search and MCP, each `replaceable: true`: an extension you install under the
same name takes over instead of running twice.

| Name | What it adds |
|------|--------------|
| `modes` | `code` / `plan` / `work`, `/mode`, per-mode tool sets, models and prompt section |
| `plan` | the `plan` tool and the markdown it writes |
| `subagent` | the `agent` tool; in-process children with a fresh conversation |
| `work` | `work.json` connectors plus built-in Google/Microsoft tools; `/work` |

**Three modes** — `src/extensions/modes/`. `code` is unrestricted. `plan` and `work` are
allowlists, and each one decides three things at once: which tools stay declared to the model, which
calls the `tool_call` hook refuses, and what the model is told about the mode in the system prompt.

| Mode | Tools the model sees | `!` shell from the user |
|------|----------------------|-------------------------|
| `code` | whatever you have active | yes |
| `plan` | `read`, `grep`, `find`, `ls`, `plan`, `agent`, plus any tool that declares `readOnlyHint` | refused with the reason |
| `work` | the read tools, `edit`, `write`, `plan`, `agent`, plus every `work:*` connector tool and every `mcp__*` tool | refused with the reason |

Skills and MCP survive all three. Skills are a prompt section and `/skill:*` commands, which a tool
allowlist cannot take away; MCP tools are namespaced `mcp__<server>` and stay declared in `work` mode.
In `plan` mode an MCP tool is allowed exactly when the server declares it read-only — the same rule as
every other tool. A skill that tells the model to run a shell command works only in `code` mode, so
write skills that branch on the mode or leave the shell steps out of them.

A restricted mode takes every allowed *registered* tool rather than the intersection with your active
set, so `grep` still works in plan mode when you have it switched off by default. The allowlist, not a
denylist, is what makes `plan` safe to rely on: a third-party `deploy` tool is refused because it is not
on the list, not because someone thought to block its name. Refusals come back as tool errors that say
`Do not retry this call`, because a model that reads "not found" retries somewhere else.

`/mode`, `/mode plan|work|code|status` and the `/plan` alias (plan ↔ code) switch modes; `--lite-mode work` sets one at start-up and
`<agentDir>/lite.json` / `<project>/.pi/lite.json` keep it:

```json
{ "mode": "work", "models": { "plan": "anthropic/claude-opus-4-8", "work": "openai/gpt-5.5" } }
```

`models` swaps the model on a mode change, so plan runs on the expensive reasoning model and work on a
cheap one, in the same session. The mode is a session entry (`lite.mode`), so it survives `/tree`,
resume and restart. Sub-agents inherit the restriction: `agent` filters its child's tool list through
the same policy, so planning by delegation cannot leak write access.

**plan tool** — `src/extensions/plan/index.ts`. `plan({ title, steps, risks?, out_of_scope? })` writes
markdown to `<project>/.pi/plans/` and, in a UI mode, asks the user to approve; approving switches to
code mode so the next turn executes. In headless mode there is nobody to approve, so it records the plan
and says so. It is a tool and a file, not a permission system — the mode above is what stops writes.

**sub-agents** — `src/extensions/subagent/index.ts`. `agent({ task, context?, mutate?, tools?, model?, max_turns? })`
runs a child `AgentSession` in-process: in-memory session, nothing on disk, no project extensions,
skills, prompts or themes, and a tool allowlist from which `agent`, `plan` and `compact` are always
filtered, so a child cannot delegate or cancel its parent. `mutate` is honored only in code mode. It
streams progress through the normal tool-update channel, obeys the parent's abort signal, stops at a
turn budget (40 by default), and returns only the child's final text — the point being that fifty file
reads cost the child context, not yours. Several calls run in parallel.

Why in-process instead of the subprocess approach in
[`examples/extensions/subagent`](packages/coding-agent/examples/extensions/subagent): a built-in must
work with no installed `pi` binary, without a shell, and offline. The example is richer (markdown
agent definitions, chain mode, per-agent cost, rendered output) and spawns `pi` per child; both are
`replaceable`, so switching is a config change rather than a rewrite. That choice is open.

**work connectors** — `src/extensions/work/index.ts`, documented in
[work-connectors.md](packages/coding-agent/docs/work-connectors.md). A `work.json` under
`~/.pi/agent/` or `<project>/.pi/` declares connectors; every command becomes a typed tool
(`gmail_search`, `runbook_search`) over a direct `argv` (no shell) or an HTTP request. Secrets use pi's
existing config-value syntax (`$NAME`, `!command`) and resolve before model values are substituted, so
a tool argument cannot reach your environment. Six connectors for Google Workspace and Microsoft 365
are already defined in code and load themselves when their credentials exist
([presets.ts](packages/coding-agent/src/extensions/work/presets.ts));
`/work` prints what to set for the ones that are off.

### Talking to models

Nothing here replaces pi's credential machinery; the modes only pick which model to point at.

| Want | How |
|------|-----|
| a hosted API key | `ANTHROPIC_API_KEY` & friends in the environment, or `pi --api-key` |
| a provider sign-in flow | `/login <provider>`, which stores an `oauth` credential in `<agentDir>/auth.json` |
| any OpenAI-compatible endpoint | `models.json`: `baseUrl`, `api: "openai-completions"`, `apiKey` (see [models.md](packages/coding-agent/docs/models.md)) — this is how Ollama, vLLM, LM Studio and an internal gateway are added |
| a local GGUF with no server | `/llama` (`src/extensions/llama`), which downloads from Hugging Face and runs it |
| a different model per mode | `models` in `lite.json`, as above |

Precedence when several are configured: `--api-key`, then `auth.json`, then a `models.json` `apiKey`,
then environment or ambient cloud credentials. Offline is the default
([above](#offline-is-the-default)), so a provider that needs the network is used only when you ask for it.

## Deliberate limits

- No permission system. Pi never had one; `work`'s `readOnly` flag and tool annotations are hints, not
  enforcement. Sandboxing stays a container problem
  ([containerization.md](packages/coding-agent/docs/containerization.md)).
- Mode gating is a tool-name and annotation allowlist. A tool that mutates state but declares
  `readOnlyHint: true` is believed, and gets run in plan mode. The same trust runs through
  `work`: a connector's `readOnly` is the config author's claim.
- `plan` and `work` hide tools from the model and refuse them at `tool_call`. They do not sandbox the
  `edit`/`write` tools' contents, and they cannot stop a mode from being switched by a user command —
  the modes are focus, not containment.
- Fork identity is not done: the binary is still `pi`, the scope is still `@earendil-works`, the
  config directory is still `.pi`, and env vars still use `PI_`. Renaming is mechanical (708 files
  mention the scope) and is held back until the feature set settles.

## Checking a change

```bash
npm ci --ignore-scripts
npx tsc --noEmit                     # compare against the stub-catalog baseline, not zero
npx biome check packages/coding-agent/src
./pi-test.sh --no-env --version      # startup path, no credentials
cd packages/coding-agent
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/suite/lite-plan.test.ts
```

The last line is the form for one test file; the fork's own tests are
`test/suite/lite-plan.test.ts`, `test/suite/lite-subagent.test.ts`, `test/lite-work-connectors.test.ts`,
plus the retargeted `test/keybindings-migration.test.ts`, `test/models-json-config-values.test.ts` and
`test/suite/regressions/5661-uppercase-header-values.test.ts`.

## Open decisions

1. Promote `examples/extensions/plan-mode` (bash allowlist, `/todos`, `[DONE:n]` progress widget) over
   the lean built-in, and merge its `tool_call` block into it.
2. Keep `durable`, `chord`, `env`, `server`, `client`, `protocol` and `evals` (~33k lines, mostly the
   experimental client/server split) or prune the monorepo to `ai`, `agent`, `coding-agent`, `tui`,
   `mcp`, `codemode`. Pruning also collapses the 13-package manual build chain in the root `package.json`.
3. Own the model catalog: check a pinned `models.json` into the repo and stop hydrating from pi.dev.
4. Rename to `pi-lite` (`bin`, config dir, `PI_` prefix, docs URLs) or keep the upstream names to stay
   diffable.
