import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { addAttachment, getChat } from '$lib/server/chats';
import { prepareAttachment, UnsupportedAttachmentError } from '$lib/server/attachments';

export const POST: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	// Code sessions are chat rows too, so this endpoint serves both modes.
	const chat = getChat(params.id, user.id);
	if (!chat) error(404, 'Chat not found');

	const form = await request.formData().catch(() => null);
	const file = form?.get('file');
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
