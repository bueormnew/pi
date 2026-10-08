/**
 * Per-project mode state, shared by the modes, plan and sub-agent extensions.
 *
 * Keyed by cwd rather than held in a module global so that several sessions over different projects
 * in one process (RPC mode, SDK hosts) do not switch each other's modes.
 */

import { DEFAULT_MODE, isLiteMode, type LiteMode } from "./policy.ts";

const modes = new Map<string, LiteMode>();
const listeners = new Map<string, Set<(mode: LiteMode) => void>>();

export function getMode(cwd: string): LiteMode {
	return modes.get(cwd) ?? DEFAULT_MODE;
}

/** Record the mode. Returns false when it was already current, so callers can skip the work. */
export function setMode(cwd: string, mode: LiteMode): boolean {
	if (getMode(cwd) === mode) return false;
	modes.set(cwd, mode);
	for (const listener of listeners.get(cwd) ?? []) listener(mode);
	return true;
}

/** Read a raw config value, ignoring anything that is not a mode name. */
export function parseMode(value: unknown): LiteMode | undefined {
	return isLiteMode(value) ? value : undefined;
}

export function subscribeToMode(cwd: string, listener: (mode: LiteMode) => void): () => void {
	const current = listeners.get(cwd) ?? new Set<(mode: LiteMode) => void>();
	current.add(listener);
	listeners.set(cwd, current);
	return () => {
		current.delete(listener);
		if (current.size === 0) listeners.delete(cwd);
	};
}

/** Test hook: drop all recorded modes. */
export function resetModes(): void {
	modes.clear();
	listeners.clear();
}
