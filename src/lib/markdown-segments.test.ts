import { describe, expect, it } from 'vitest';
import { segmentMarkdown } from './markdown-segments';

describe('segmentMarkdown', () => {
	it('leaves plain markdown as one segment', () => {
		expect(segmentMarkdown('# Hi\n\nSome text.')).toEqual([
			{ kind: 'md', content: '# Hi\n\nSome text.' }
		]);
	});

	it('pulls a fenced block out with its language', () => {
		const out = segmentMarkdown('Before\n\n```ts\nconst a = 1;\n```\n\nAfter');
		expect(out.map((s) => s.kind)).toEqual(['md', 'code', 'md']);
		expect(out[1]).toEqual({ kind: 'code', content: 'const a = 1;', lang: 'ts' });
	});

	it('handles a fence with no language', () => {
		const out = segmentMarkdown('```\nplain\n```');
		expect(out).toEqual([{ kind: 'code', content: 'plain', lang: '' }]);
	});

	it('renders a complete mermaid fence as a diagram', () => {
		const out = segmentMarkdown('```mermaid\ngraph TD;\nA-->B;\n```');
		expect(out).toEqual([{ kind: 'mermaid', content: 'graph TD;\nA-->B;' }]);
	});

	it('renders an unterminated fence as code, so streaming does not flash raw text', () => {
		const out = segmentMarkdown('Here:\n\n```py\nprint("par');
		expect(out.map((s) => s.kind)).toEqual(['md', 'code']);
		expect(out[1].content).toBe('print("par');
	});

	it('keeps an unterminated mermaid fence as code until it closes', () => {
		// Handing a partial diagram to mermaid throws and flashes an error box.
		const partial = segmentMarkdown('```mermaid\ngraph T');
		expect(partial[0].kind).toBe('code');
	});

	it('supports tilde fences and longer markers', () => {
		expect(segmentMarkdown('~~~js\nx\n~~~')).toEqual([{ kind: 'code', content: 'x', lang: 'js' }]);
		expect(segmentMarkdown('````\na\n````')).toEqual([{ kind: 'code', content: 'a', lang: '' }]);
	});

	it('does not close a backtick fence on a tilde line', () => {
		const out = segmentMarkdown('```\na\n~~~\nb\n```');
		expect(out).toEqual([{ kind: 'code', content: 'a\n~~~\nb', lang: '' }]);
	});

	it('keeps nested shorter fences inside a longer one', () => {
		const out = segmentMarkdown('````md\n```\ninner\n```\n````');
		expect(out).toEqual([{ kind: 'code', content: '```\ninner\n```', lang: 'md' }]);
	});

	it('handles several blocks in one message', () => {
		const out = segmentMarkdown('a\n```sh\nls\n```\nb\n```mermaid\ngraph TD;\n```\nc');
		expect(out.map((s) => s.kind)).toEqual(['md', 'code', 'md', 'mermaid', 'md']);
	});
});
