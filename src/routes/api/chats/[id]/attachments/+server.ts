import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { addAttachment, getChat } from '$lib/server/chats';

const MAX_SIZE = 5 * 1024 * 1024;
const ALLOWED_PREFIXES = ['image/'];

export const POST: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	const chat = getChat(params.id, user.id);
	if (!chat) error(404, 'Chat not found');

	const form = await request.formData().catch(() => null);
	const file = form?.get('file');
	if (!(file instanceof File)) error(400, 'Expected multipart form with a "file" field');
	if (file.size > MAX_SIZE) error(413, 'File too large (5 MB limit)');
	if (!ALLOWED_PREFIXES.some((p) => file.type.startsWith(p))) {
		error(415, 'Only images are supported for now');
	}

	const ref = addAttachment(chat.id, {
		name: file.name || 'upload',
		mime: file.type,
		data: Buffer.from(await file.arrayBuffer())
	});
	return json(ref, { status: 201 });
};
