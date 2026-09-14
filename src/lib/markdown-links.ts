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
