import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { addCardAttachment, getCard } from '$lib/server/boards';
import { prepareAttachment, UnsupportedAttachmentError } from '$lib/server/attachments';
import { formatBytes } from '$lib/attachment-types';

function messageOf(err: unknown): string {
	return String(err instanceof Error ? err.message : err);
}

/** adapter-node reports an over-limit body from inside the body stream. */
function bodyTooLarge(err: unknown): boolean {
	if ((err as { status?: unknown })?.status === 413) return true;
	return /exceeds limit|BODY_SIZE_LIMIT|too large/i.test(messageOf(err));
}

export const POST: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	if (!getCard(params.id, user.id)) error(404, 'Card not found');

	let form: FormData;
	try {
		form = await request.formData();
	} catch (err) {
		if (bodyTooLarge(err)) {
			const length = Number(request.headers.get('content-length'));
			const size = Number.isFinite(length) && length > 0 ? formatBytes(length) : 'The upload';
			error(413, `${size} exceeds the server's request limit. Raise BODY_SIZE_LIMIT (see docs/INSTALL.md).`);
		}
		error(400, `Could not read the upload: ${messageOf(err)}`);
	}

	const file = form.get('file');
	if (!(file instanceof File)) error(400, 'Expected multipart form with a "file" field');

	const data = Buffer.from(await file.arrayBuffer());
	const name = file.name || 'upload';
	let prepared;
	try {
		// Same limits and extraction as chat attachments — a card attachment is
		// something an agent will be handed, so it has to be readable text too.
		prepared = await prepareAttachment(name, file.type, data);
	} catch (err) {
		if (err instanceof UnsupportedAttachmentError) error(415, err.message);
		error(422, `Could not read ${name}: ${String(err)}`);
	}

	const row = addCardAttachment(params.id, user.id, {
		name,
		mime: file.type || 'application/octet-stream',
		data,
		kind: prepared.kind,
		text: prepared.text
	});
	if (!row) error(404, 'Card not found');
	return json(
		{ id: row.id, name: row.name, mime: row.mime, size: row.size, kind: row.kind },
		{ status: 201 }
	);
};
