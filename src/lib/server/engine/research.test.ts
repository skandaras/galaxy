import { describe, it, expect } from 'vitest';
import { assertPublicHttpUrl, htmlToText } from './research';

describe('assertPublicHttpUrl', () => {
	it('blocks loopback, private and link-local targets', () => {
		for (const bad of [
			'http://127.0.0.1/x',
			'http://localhost/x',
			'http://10.0.0.5/x',
			'http://192.168.1.1/x',
			'http://172.18.0.2/x',
			'http://169.254.169.254/latest/meta-data',
			'http://docker.internal/x',
			'http://nas.local/x',
			'file:///etc/passwd'
		]) {
			expect(() => assertPublicHttpUrl(bad), bad).toThrow(/Blocked/);
		}
	});
	it('allows normal public urls', () => {
		expect(() => assertPublicHttpUrl('https://example.com/page')).not.toThrow();
		expect(() => assertPublicHttpUrl('http://93.184.216.34/x')).not.toThrow();
	});
});

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
