/**
 * The `plan` tool: an implementation plan as a markdown file, and the approval step that leaves
 * plan mode.
 *
 * Gating is not here. `modes` refuses state-changing calls while the session is in plan mode; this
 * file only records a plan and hands the user the decision. Approving switches to `code` so the next
 * turn executes the plan instead of describing it.
 *
 * Why a file and not just chat text: the plan outlives the context window. Compaction summarizes the
 * conversation; `.pi/plans/*.md` is still there for the next session, and it is reviewable in a diff.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { CONFIG_DIR_NAME } from "../../config.ts";
import { defineTool, type ExtensionAPI } from "../../core/extensions/types.ts";
import { getMode, setMode } from "../modes/store.ts";

export interface PlanStep {
	title: string;
	detail?: string;
	verify?: string;
}

export interface PlanInput {
	title: string;
	steps: PlanStep[];
	risks?: string[];
	out_of_scope?: string[];
}

export interface PlanDetails {
	path: string;
	approved: boolean;
	modeAfter: string;
	stepCount: number;
}

const planParameters = Type.Object({
	title: Type.String({ description: "Short imperative title for the plan" }),
	steps: Type.Array(
		Type.Object({
			title: Type.String({ description: "What this step does" }),
			detail: Type.Optional(Type.String({ description: "How: files, functions, commands involved" })),
			verify: Type.Optional(Type.String({ description: "How to tell the step is done (test, command, check)" })),
		}),
		{ minItems: 1, description: "Ordered steps, each one independently checkable" },
	),
	risks: Type.Optional(Type.Array(Type.String({}), { description: "What can go wrong and how to recover" })),
	out_of_scope: Type.Optional(
		Type.Array(Type.String({}), { description: "Adjacent work this plan deliberately excludes" }),
	),
});

function slugify(title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug.length > 0 ? slug.slice(0, 48) : "plan";
}

export function renderPlanMarkdown(input: PlanInput, createdAt: string): string {
	const lines: string[] = [`# ${input.title}`, "", `_Created ${createdAt} by pi-lite._`, "", "## Steps", ""];
	input.steps.forEach((step, index) => {
		lines.push(`${index + 1}. **${step.title}**`);
		if (step.detail) lines.push(`   - ${step.detail}`);
		if (step.verify) lines.push(`   - Verify: ${step.verify}`);
	});
	if (input.risks && input.risks.length > 0) {
		lines.push("", "## Risks", "", ...input.risks.map((risk) => `- ${risk}`));
	}
	if (input.out_of_scope && input.out_of_scope.length > 0) {
		lines.push("", "## Out of scope", "", ...input.out_of_scope.map((item) => `- ${item}`));
	}
	return `${lines.join("\n")}\n`;
}

/** Write the plan under `<cwd>/<configDir>/plans/` and return its path and contents. */
export function writePlanFile(cwd: string, input: PlanInput): { path: string; markdown: string } {
	const createdAt = new Date().toISOString();
	const markdown = renderPlanMarkdown(input, createdAt);
	const dir = join(cwd, CONFIG_DIR_NAME, "plans");
	mkdirSync(dir, { recursive: true });
	const stamp = createdAt.replace(/[:.]/g, "-");
	const path = join(dir, `${stamp}-${slugify(input.title)}.md`);
	writeFileSync(path, markdown, "utf-8");
	return { path, markdown };
}

export function createPlanToolDefinition() {
	return defineTool({
		name: "plan",
		label: "Plan",
		description:
			"Record an implementation plan as markdown. Call it after researching with read-only tools, with steps specific to this repository. In plan mode the user is asked to approve it, and approval switches to code mode so the next turn executes it.",
		promptSnippet: "Record a step-by-step implementation plan to a markdown file",
		promptGuidelines: [
			"In plan mode, do not retry blocked tools; research, then call plan",
			"Write plan steps that name the files and functions to change, each with a way to verify it",
		],
		parameters: planParameters,
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
		exposure: "direct",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { path, markdown } = writePlanFile(ctx.cwd, params as PlanInput);
			const mode = getMode(ctx.cwd);
			let approved = false;
			if (mode === "plan" && ctx.hasUI) {
				approved = await ctx.ui.confirm(
					"Approve plan?",
					`${params.title}\n\n${params.steps.length} step(s). Plan file: ${path}\n\nApproving switches to code mode so the next turn executes the plan.`,
				);
			}
			const modeAfter = approved ? "code" : mode;
			if (approved) setMode(ctx.cwd, "code");

			const summary = approved
				? "Plan approved. Switched to code mode; execute the plan now."
				: mode === "plan"
					? `Plan written to ${path}. Still in plan mode: wait for the user to approve or change it.`
					: `Plan written to ${path}.`;
			return {
				content: [{ type: "text", text: `${summary}\n\n${markdown}` }],
				details: {
					path,
					approved,
					modeAfter,
					stepCount: params.steps.length,
				} satisfies PlanDetails,
			};
		},
	});
}

export default function planExtension(pi: ExtensionAPI): void {
	pi.registerTool(createPlanToolDefinition());
}
