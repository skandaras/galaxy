/**
 * Pull the first JSON object out of a model reply.
 *
 * Models asked for "ONLY JSON" still wrap it in prose or a fenced block often
 * enough that parsing the raw text is not worth attempting; taking the span
 * between the outermost braces handles both without a markdown parser.
 */
export function extractJson(text: string): Record<string, unknown> | null {
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	if (start === -1 || end <= start) return null;
	try {
		return JSON.parse(text.slice(start, end + 1));
	} catch {
		return null;
	}
}
