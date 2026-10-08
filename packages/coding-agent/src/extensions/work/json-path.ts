/**
 * Dotted path lookup for connector `capture`, e.g. `body.endOfSegment.index` or `files.0.id`.
 *
 * Connectors chain requests (read a document, then write at its end), so a step has to pull a value
 * out of the previous JSON response. A dotted path with numeric segments for arrays is the whole
 * feature; anything more (filters, slices) would turn a config file into a programming language.
 */

export function pickJson(value: unknown, path: string): string | number | boolean | undefined {
	let current: unknown = value;
	for (const segment of path.split(".")) {
		if (segment.length === 0) continue;
		if (Array.isArray(current)) {
			const index = Number(segment);
			if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
			current = current[index];
			continue;
		}
		if (typeof current !== "object" || current === null) return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	if (typeof current === "string" || typeof current === "number" || typeof current === "boolean") {
		return current;
	}
	return undefined;
}
