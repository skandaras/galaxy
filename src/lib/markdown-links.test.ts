import { describe, expect, it } from 'vitest';
import { releaseApiLinks } from './markdown-links';

/**
 * The input here is what `marked` + DOMPurify actually emit — double-quoted
 * attributes, in source order. The real pipeline needs a DOM and this suite
 * runs in node, so the shape is reproduced rather than generated.
 */
describe('releaseApiLinks', () => {
	it('hands an attachment link to the browser', () => {
		const html = '<p><a href="/api/chats/abc/attachments/def">drawing.svg</a></p>';
		expect(releaseApiLinks(html)).toBe(
			'<p><a href="/api/chats/abc/attachments/def" data-sveltekit-reload>drawing.svg</a></p>'
		);
	});

	it('leaves an ordinary in-app link to the router', () => {
		// These are exactly what client-side navigation is for.
		const html = '<a href="/library">the library</a>';
		expect(releaseApiLinks(html)).toBe(html);
	});

	it('leaves external links alone', () => {
		const html = '<a href="https://example.com/api/x">elsewhere</a>';
		expect(releaseApiLinks(html)).toBe(html);
	});

	it('keeps whatever else the sanitiser put on the anchor', () => {
		const html = '<a title="open it" href="/api/cards/1/attachments/2">plan.pdf</a>';
		expect(releaseApiLinks(html)).toContain('title="open it"');
		expect(releaseApiLinks(html)).toContain('data-sveltekit-reload');
	});

	it('does not mark the same anchor twice', () => {
		const once = releaseApiLinks('<a href="/api/x/y">f</a>');
		expect(releaseApiLinks(once)).toBe(once);
	});

	it('marks every link in a reply, not just the first', () => {
		const html = '<a href="/api/a/b">one</a> and <a href="/api/c/d">two</a>';
		expect(releaseApiLinks(html).match(/data-sveltekit-reload/g)).toHaveLength(2);
	});
});
