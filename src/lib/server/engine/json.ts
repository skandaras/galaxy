/**
 * Pull the first JSON **object** out of a model reply.
 *
 * Models asked for "ONLY JSON" still wrap it in prose or a fenced block often
 * enough that parsing the raw text is not worth attempting; taking the span
 * between the outermost braces handles both without a markdown parser.
 *
 * An object, and only an object. A reply that is a top-level *array* spans from
 * its first `{` to its last `}` — which is the elements without their brackets,
 * so it either fails to parse or, with a single element, quietly returns that
 * one item as though it were the whole answer. Every prompt in this codebase
 * therefore asks for an object with the array inside it. The Cortex groomer
 * asked for a bare array for two phases and silently discarded every suggestion
 * a model made; nothing noticed, because nothing tested the model path.
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
