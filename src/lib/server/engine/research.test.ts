import { describe, it, expect } from 'vitest';
import { htmlToText } from './research';

describe('htmlToText', () => {
	it('strips scripts, styles and tags, keeps content', () => {
		const html =
			'<html><head><style>body{color:red}</style></head><body><script>var x=1;</script><h1>Title</h1><p>Hello &amp; welcome.</p><div>Line two</div></body></html>';
		const text = htmlToText(html);
		expect(text).toContain('Title');
		expect(text).toContain('Hello & welcome.');
		expect(text).toContain('Line two');
		expect(text).not.toContain('var x');
		expect(text).not.toContain('color:red');
		expect(text).not.toContain('<');
	});

	it('preserves paragraph breaks', () => {
		const lines = htmlToText('<p>a</p><p>b</p>')
			.split('\n')
			.map((l) => l.trim());
		expect(lines).toEqual(['a', 'b']);
	});
});
