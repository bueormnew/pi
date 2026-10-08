/**
 * Sub-agents: delegate a self-contained task to a child session and get its answer back.
 *
 * The child runs in the same process with its own conversation: an in-memory session (nothing is
 * written to disk), no project extensions, skills, prompts or themes, and a tool allowlist that
 * never includes `agent`, so a child cannot delegate further. It shares the parent's cwd, model
 * and credentials.
 *
 * Problem this solves: a research task pollutes the parent's context with dozens of file reads and
 * command outputs. The child burns its own context on that work and returns only the conclusion.
 */

import { Type } from "typebox";
import { getAgentDir } from "../../config.ts";
import type { AgentSessionEvent } from "../../core/agent-session.ts";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionToolContext,
	type ToolDefinition,
} from "../../core/extensions/types.ts";
import { DefaultResourceLoader } from "../../core/resource-loader.ts";
import { createAgentSession } from "../../core/sdk.ts";
import { SessionManager } from "../../core/session-manager.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { type LiteMode, subagentToolsForMode } from "../modes/policy.ts";
import { getMode } from "../modes/store.ts";

/** Tools a child may use when the caller does not name any. Read-only plus `bash` for inspection. */
export const DEFAULT_SUBAGENT_TOOLS = ["read", "grep", "find", "ls", "bash"];
/** Tools granted on top of the defaults when `mutate` is set. */
export const MUTATING_TOOLS = ["edit", "write"];
/** A child never gets these: no delegation, no plan-mode gating, no self-cancellation. */
export const NEVER_SUBAGENT_TOOLS = ["agent", "plan", "compact"];
export const DEFAULT_MAX_TURNS = 40;

export interface SubagentInput {
	task: string;
	context?: string;
	mutate?: boolean;
	tools?: string[];
	model?: string;
	max_turns?: number;
	label?: string;
}

export interface SubagentDetails {
	label: string;
	tools: string[];
	model: string | undefined;
	turns: number;
	toolCalls: number;
	aborted: boolean;
	outputChars: number;
}

/** What the runner needs from a child session. Narrow on purpose, so it can be replaced in tests. */
export interface SubagentSession {
	subscribe(listener: (event: AgentSessionEvent) => void): () => void;
	prompt(text: string): Promise<void>;
	abort(): Promise<void> | void;
	dispose(): void;
	getLastAssistantText(): string | undefined;
}

export interface SubagentRequest {
	cwd: string;
	task: string;
	instructions: string[];
	tools: string[];
	model: ExtensionToolContext["model"];
	thinkingLevel: ExtensionToolContext["thinkingLevel"];
	/** Stop the child after this many turns. */
	maxTurns: number;
	signal: AbortSignal | undefined;
}

export type SubagentRunner = (request: SubagentRequest) => Promise<SubagentSession>;

/**
 * Resolve the child's tool allowlist. Children never receive the delegating or session tools, and a
 * restricted parent mode caps what they may use: a child is a separate session, so nothing else stops
 * it from writing files while the parent is in plan mode.
 */
export function resolveSubagentTools(
	input: Pick<SubagentInput, "tools" | "mutate">,
	mode: LiteMode = "code",
): string[] {
	const requested = input.tools && input.tools.length > 0 ? input.tools : DEFAULT_SUBAGENT_TOOLS;
	const tools = input.mutate && mode === "code" ? [...requested, ...MUTATING_TOOLS] : requested;
	return subagentToolsForMode(mode, tools);
}

/** Track the child's progress for the caller's live render, and enforce the turn budget. */
export function createProgressTracker(maxTurns: number, onTurnLimit: () => void) {
	let turns = 0;
	let toolCalls = 0;
	let text = "";

	const onEvent = (event: AgentSessionEvent): void => {
		if (event.type === "turn_end") {
			turns++;
			if (turns >= maxTurns) onTurnLimit();
		} else if (event.type === "tool_execution_start") {
			toolCalls++;
		} else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			text += event.assistantMessageEvent.delta;
		}
	};

	return { onEvent, summary: () => ({ turns, toolCalls, preview: text.slice(-400) }) };
}

/** The production runner: a fresh in-process AgentSession with a locked-down resource load. */
export const defaultSubagentRunner: SubagentRunner = async (request) => {
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(request.cwd, agentDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd: request.cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		appendSystemPrompt: request.instructions,
	});
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd: request.cwd,
		agentDir,
		settingsManager,
		resourceLoader,
		sessionManager: SessionManager.inMemory(request.cwd),
		model: request.model,
		tools: request.tools,
		thinkingLevel: request.thinkingLevel,
	});
	await session.bindExtensions({});
	return session;
};

export interface SubagentToolOptions {
	/** Replaces the in-process child session, for tests and SDK hosts with their own runtime. */
	runner?: SubagentRunner;
	/** Resolves a `provider/model` string for the child. Undefined rejects the request. */
	resolveModel?: (spec: string, ctx: ExtensionToolContext) => ExtensionToolContext["model"] | undefined;
}

function findModel(spec: string, ctx: ExtensionToolContext): ExtensionToolContext["model"] | undefined {
	const [provider, ...rest] = spec.split("/");
	const modelId = rest.join("/");
	if (!provider || !modelId) return undefined;
	const found = ctx.modelRegistry.find(provider, modelId);
	return found && ctx.modelRegistry.hasConfiguredAuth(found) ? found : undefined;
}

export function createAgentToolDefinition(options: SubagentToolOptions = {}): ToolDefinition {
	const runner = options.runner ?? defaultSubagentRunner;
	const resolveModel = options.resolveModel ?? findModel;

	return defineTool({
		name: "agent",
		label: "Sub-agent",
		description:
			"Delegate a self-contained task to a sub-agent with a fresh conversation and get its answer. It sees only what you write here, so include every file path, constraint and question it needs. Use it for broad research, audits and read-only verification; do the editing yourself.",
		promptSnippet: "Delegate research or verification to a sub-agent with a fresh context",
		promptGuidelines: [
			"Delegate multi-file research, audits and verification to agent instead of reading everything into this conversation",
			"Each agent call starts from scratch: put the file paths, the question and the expected answer shape in `task`",
			"Set mutate only when the sub-agent must change files; leave read-only research to the default tool set",
		],
		parameters: Type.Object({
			task: Type.String({ description: "The whole assignment: what to do, where to look, what to report back" }),
			context: Type.Optional(Type.String({ description: "Constraints and background the child cannot infer" })),
			mutate: Type.Optional(
				Type.Boolean({ description: "Grant edit and write in addition to the read-only tool set. Default: false" }),
			),
			tools: Type.Optional(
				Type.Array(Type.String({}), {
					description: `Tool allowlist. Default: ${DEFAULT_SUBAGENT_TOOLS.join(", ")}`,
				}),
			),
			model: Type.Optional(
				Type.String({ description: "Provider/model id for the child, for example anthropic/claude-sonnet-4-5" }),
			),
			max_turns: Type.Optional(
				Type.Number({ description: `Stop the child after this many turns. Default: ${DEFAULT_MAX_TURNS}` }),
			),
			label: Type.Optional(Type.String({ description: "Short name for progress display" })),
		}),
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		// Several sub-agents can run at once; the caller batches independent questions.
		executionMode: "parallel",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const tools = resolveSubagentTools(params, getMode(ctx.cwd));
			if (tools.length === 0) {
				return {
					content: [{ type: "text", text: `No tools are usable by a sub-agent in ${getMode(ctx.cwd)} mode.` }],
					details: {
						label: params.label ?? params.task.slice(0, 40),
						tools: [],
						model: undefined,
						turns: 0,
						toolCalls: 0,
						aborted: false,
						outputChars: 0,
					},
					isError: true,
				};
			}
			const maxTurns = params.max_turns && params.max_turns > 0 ? params.max_turns : DEFAULT_MAX_TURNS;
			const label = params.label ?? params.task.slice(0, 40);

			let model = ctx.model;
			if (params.model) {
				const found = resolveModel(params.model, ctx);
				if (!found) {
					return {
						content: [{ type: "text", text: `Model not available for sub-agent: ${params.model}` }],
						details: {
							label,
							tools,
							model: params.model,
							turns: 0,
							toolCalls: 0,
							aborted: false,
							outputChars: 0,
						},
						isError: true,
					};
				}
				model = found;
			}

			const instructions = [
				`You are a sub-agent handling one delegated task (id ${toolCallId}). You cannot talk to the user. ` +
					"Answer with the findings the caller asked for, citing file paths and line numbers. " +
					"Do not start unrelated work, and do not assume anything about the parent conversation.",
				params.context ? `Background: ${params.context}` : "",
			].filter((line) => line.length > 0);

			let session: SubagentSession | undefined;
			let overTurnLimit = false;
			const tracker = createProgressTracker(maxTurns, () => {
				overTurnLimit = true;
				void session?.abort();
			});
			const details = (extra: Partial<SubagentDetails> = {}): SubagentDetails => ({
				label,
				tools,
				model: model ? `${model.provider}/${model.id}` : undefined,
				turns: 0,
				toolCalls: 0,
				aborted: false,
				outputChars: 0,
				...extra,
			});

			try {
				session = await runner({
					cwd: ctx.cwd,
					task: params.task,
					instructions,
					tools,
					model,
					thinkingLevel: ctx.thinkingLevel,
					maxTurns,
					signal,
				});
				const unsubscribe = session.subscribe(tracker.onEvent);
				const abortChild = () => void session?.abort();
				signal?.addEventListener("abort", abortChild);

				onUpdate?.({ content: [{ type: "text", text: `sub-agent running: ${label}` }], details: details() });
				await session.prompt(params.task);
				unsubscribe();
				signal?.removeEventListener("abort", abortChild);

				const answer = session.getLastAssistantText() ?? "";
				const summary = tracker.summary();
				const aborted = overTurnLimit || signal?.aborted === true;
				const prefix = aborted
					? `sub-agent stopped after ${summary.turns} turn(s) (limit ${maxTurns}${signal?.aborted ? ", aborted" : ""}).\n\n`
					: "";
				return {
					content: [
						{ type: "text", text: `${prefix}${answer.length > 0 ? answer : "(the sub-agent produced no text)"}` },
					],
					details: details({
						turns: summary.turns,
						toolCalls: summary.toolCalls,
						aborted,
						outputChars: answer.length,
					}),
				};
			} catch (error) {
				const summary = tracker.summary();
				return {
					content: [
						{ type: "text", text: `sub-agent failed: ${error instanceof Error ? error.message : String(error)}` },
					],
					details: details({ turns: summary.turns, toolCalls: summary.toolCalls, aborted: true }),
					isError: true,
				};
			} finally {
				session?.dispose();
			}
		},
	});
}

export interface SubagentExtensionOptions extends SubagentToolOptions {
	/** Tools the parent allows the child to request beyond the defaults. Reserved for hosts. */
	allowDeeperDelegation?: boolean;
}

export function createSubagentExtension(options: SubagentExtensionOptions = {}): (pi: ExtensionAPI) => void {
	return (pi) => {
		pi.registerTool(createAgentToolDefinition(options));

		pi.registerCommand("subagents", {
			description: "Show the sub-agent tool's default tool set and limits.",
			handler: async (_args, ctx) => {
				ctx.ui.notify(
					`agent: default tools ${DEFAULT_SUBAGENT_TOOLS.join(", ")}; never ${NEVER_SUBAGENT_TOOLS.join(", ")}. ` +
						`Turn limit ${DEFAULT_MAX_TURNS}. In-process child, in-memory session, no project extensions.`,
					"info",
				);
			},
		});
	};
}

export default createSubagentExtension();
