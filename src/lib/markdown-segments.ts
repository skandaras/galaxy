export interface Segment {
	kind: 'md' | 'mermaid' | 'code' | 'svg';
	content: string;
	lang?: string;
}

const FENCE_OPEN = /^(\s{0,3})(`{3,}|~{3,})\s*([^\s`]*)/;
const FENCE_CLOSE = /^\s{0,3}(`{3,}|~{3,})\s*$/;

/**
 * Split fenced blocks out of markdown so mermaid renders as a diagram, svg
 * renders as a picture, and every other block gets its own component (and a
 * copy button).
 *
 * A line scanner rather than a regex because this re-runs on every streamed
 * delta: a fence that hasn't been closed yet must already render as a code
 * block, otherwise a half-written snippet flashes as raw text and reflows when
 * the closing fence finally arrives.
 */
export function segmentMarkdown(input: string): Segment[] {
	const out: Segment[] = [];
	let md: string[] = [];
	let fence: { marker: string; lang: string; body: string[] } | null = null;

	const flushMd = () => {
		if (md.length) out.push({ kind: 'md', content: md.join('\n') });
		md = [];
	};
	const flushFence = (closed: boolean) => {
		if (!fence) return;
		const content = fence.body.join('\n');
		// Only hand a *complete* block to a renderer. Parsing a partial diagram
		// throws, which would flash an error box on every delta, and half an SVG
		// draws as a mangled one that reflows when the rest arrives.
		const rendered = closed && (fence.lang === 'mermaid' || fence.lang === 'svg');
		out.push(
			rendered
				? { kind: fence.lang as 'mermaid' | 'svg', content }
				: { kind: 'code', content, lang: fence.lang }
		);
		fence = null;
	};

	for (const line of input.split('\n')) {
		if (fence) {
			const close = FENCE_CLOSE.exec(line);
			if (close && close[1][0] === fence.marker[0] && close[1].length >= fence.marker.length) {
				flushFence(true);
			} else {
				fence.body.push(line);
			}
			continue;
		}
		const open = FENCE_OPEN.exec(line);
		if (open) {
			flushMd();
			fence = { marker: open[2], lang: open[3] ?? '', body: [] };
			continue;
		}
		md.push(line);
	}
	flushFence(false);
	flushMd();
	return out;
}
