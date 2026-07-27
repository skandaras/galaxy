import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { addAttachment, getChat } from '$lib/server/chats';
import { prepareAttachment, UnsupportedAttachmentError } from '$lib/server/attachments';
import { formatBytes } from '$lib/attachment-types';

function messageOf(err: unknown): string {
	return String(err instanceof Error ? err.message : err);
}

/**
 * SvelteKit signals an over-limit body as a 413 SvelteKitError. Match on the
 * status where present and fall back to the message, since the error crosses a
 * stream boundary and isn't guaranteed to keep its class.
 */
function bodyTooLarge(err: unknown): boolean {
	const status = (err as { status?: unknown })?.status;
	if (status === 413) return true;
	return /exceeds limit|BODY_SIZE_LIMIT|too large/i.test(messageOf(err));
}

function describeSize(request: Request): string {
	const length = Number(request.headers.get('content-length'));
	return Number.isFinite(length) && length > 0
		? `Upload of ${formatBytes(length)}`
		: 'The upload';
}

export const POST: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	// Code sessions are chat rows too, so this endpoint serves both modes.
	const chat = getChat(params.id, user.id);
	if (!chat) error(404, 'Chat not found');

	// adapter-node enforces BODY_SIZE_LIMIT *inside the body stream*, so an
	// oversized upload doesn't fail at the route boundary — it fails here, the
	// moment the body is read. Swallowing this is how a 413 used to be reported
	// as a bogus "no file field" 400.
	let form: FormData;
	try {
		form = await request.formData();
	} catch (err) {
		if (bodyTooLarge(err)) {
			error(413, `${describeSize(request)} exceeds the server's request limit. Raise BODY_SIZE_LIMIT (see docs/INSTALL.md).`);
		}
		error(400, `Could not read the upload: ${messageOf(err)}`);
	}

	const file = form.get('file');
	if (!(file instanceof File)) error(400, 'Expected multipart form with a "file" field');

	const data = Buffer.from(await file.arrayBuffer());
	const name = file.name || 'upload';
	let prepared;
	try {
		prepared = await prepareAttachment(name, file.type, data);
	} catch (err) {
		// Type and size rejections carry a message written for the user; a
		// parser blowing up on a corrupt file should not read as a 500.
		if (err instanceof UnsupportedAttachmentError) error(415, err.message);
		error(422, `Could not read ${name}: ${String(err)}`);
	}

	const ref = addAttachment(chat.id, {
		name,
		mime: file.type || 'application/octet-stream',
		data,
		kind: prepared.kind,
		text: prepared.text
	});
	return json(ref, { status: 201 });
};
