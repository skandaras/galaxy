import { describe, expect, it } from 'vitest';
import { isLocalImage, releaseApiLinks, tameExternalContent } from './markdown-links';

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

describe('tameExternalContent', () => {
	it('keeps an image this app serves', () => {
		const html = '<p><img src="/api/chats/c1/attachments/a1" alt="chart"></p>';
		expect(tameExternalContent(html)).toBe(html);
	});

	it('turns an image from another site into a link that says where it goes', () => {
		// The request is the leak: the address is the model's to write, and a page
		// it read can have it put the conversation in the query string.
		const out = tameExternalContent(
			'<p><img src="https://elsewhere.example/p.png?q=secret&amp;x=1" alt="a chart"></p>'
		);
		expect(out).not.toContain('<img');
		expect(out).toContain('href="https://elsewhere.example/p.png?q=secret&amp;x=1"');
		expect(out).toContain('a chart (elsewhere.example)');
		expect(out).toContain('rel="noopener noreferrer"');
	});

	it('treats a protocol-relative address as another site', () => {
		expect(tameExternalContent('<img src="//elsewhere.example/p.png">')).toBe('');
		expect(isLocalImage('//elsewhere.example/p.png')).toBe(false);
		expect(isLocalImage('/\\elsewhere.example/p.png')).toBe(false);
		expect(isLocalImage('/api/x')).toBe(true);
		expect(isLocalImage('data:image/png;base64,AAAA')).toBe(true);
		expect(isLocalImage('data:text/html,x')).toBe(false);
	});

	it('drops a srcset, which names addresses of its own', () => {
		const out = tameExternalContent('<img src="/api/x" srcset="https://elsewhere.example/2x.png 2x" alt="">');
		expect(out).toBe('<img src="/api/x" alt="">');
	});

	it('is not fooled by a > inside an attribute', () => {
		const out = tameExternalContent('<img alt="a > b" src="https://elsewhere.example/p.png">');
		expect(out).not.toContain('<img');
		expect(out).toContain('elsewhere.example');
	});

	it('opens a link to another site in a new tab and leaves in-app links alone', () => {
		expect(tameExternalContent('<a href="https://example.com/x">x</a>')).toBe(
			'<a href="https://example.com/x" target="_blank" rel="noopener noreferrer">x</a>'
		);
		const local = '<a href="/library?doc=1">doc</a>';
		expect(tameExternalContent(local)).toBe(local);
	});
});
