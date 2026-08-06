import { error, json } from '@sveltejs/kit';
import { existsSync, readFileSync } from 'node:fs';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { deleteCardAttachment, getCard } from '$lib/server/boards';

export const GET: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	const detail = getCard(params.id, user.id);
	if (!detail) error(404, 'Card not found');
	const row = detail.attachments.find((a) => a.id === params.attachmentId);
	if (!row || !existsSync(row.path)) error(404, 'Attachment not found');
	return new Response(new Uint8Array(readFileSync(row.path)), {
		headers: {
			'content-type': row.mime,
			// Attachments are user uploads served from our own origin, so they are
			// never rendered inline.
			'content-disposition': `attachment; filename="${row.name.replace(/"/g, '')}"`
		}
	});
};

export const DELETE: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	if (!getCard(params.id, user.id)) error(404, 'Card not found');
	if (!deleteCardAttachment(params.attachmentId, user.id)) error(404, 'Attachment not found');
	return json({ ok: true });
};
