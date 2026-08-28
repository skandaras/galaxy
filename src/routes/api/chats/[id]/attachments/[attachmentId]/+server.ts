import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { attachmentBytes, getChat } from '$lib/server/chats';

/** Rendered in an <img>; anything else is handed over as a download. */
const INLINE_MIMES = new Set([
	'image/png',
	'image/jpeg',
	'image/gif',
	'image/webp',
	'image/avif',
	'image/svg+xml'
]);

/**
 * An attachment's bytes.
 *
 * This is what makes a generated image visible: the tools save what a model
 * draws as an attachment and hand the model a markdown link to here, so the
 * picture is part of the saved reply and survives a reload.
 *
 * Unlike the card route, images go out `inline` — an <img> cannot render a
 * download. SVG is the one that needs care, being model-authored markup served
 * from our own origin, so it carries a policy that makes it inert as a document
 * even if someone navigates straight to it. (In an <img> it never ran script
 * anyway; this covers the address bar.)
 */
export const GET: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	// A code session is a chat row too, so this serves both modes.
	const chat = getChat(params.id, user.id);
	if (!chat) error(404, 'Chat not found');
	const file = attachmentBytes(chat.id, params.attachmentId);
	if (!file) error(404, 'Attachment not found');

	const inline = file.kind === 'image' && INLINE_MIMES.has(file.mime);
	const headers: Record<string, string> = {
		'content-type': file.mime,
		'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${file.name.replace(/"/g, '')}"`,
		// Without this a mistyped content-type is a free pass to sniff the bytes
		// into something scriptable.
		'x-content-type-options': 'nosniff',
		// Private to one user, and the id is stable, so a browser may keep it.
		'cache-control': 'private, max-age=3600'
	};
	if (file.mime === 'image/svg+xml') {
		headers['content-security-policy'] =
			"default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";
	}
	return new Response(new Uint8Array(file.data), { headers });
};
