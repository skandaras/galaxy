import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { parseIntoDraft, PARSE_MAX_CHARS } from '$lib/server/engine/profile-parse';
import { parseExport, ProfileError } from '$lib/server/profile';

/**
 * A full profile exported at the cap runs to about fifty thousand characters.
 * It is read without a model, so it is held to this instead of the parse's
 * limit.
 */
const EXPORT_MAX_CHARS = 200_000;

/**
 * Pasted text as a draft for review: a Profile export read exactly, anything
 * else (another assistant's memory, notes) sorted by the parse call.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const body = await request.json().catch(() => ({}));
	const text = typeof body.text === 'string' ? body.text.trim() : '';
	if (!text) error(400, 'Paste something to import.');
	if (text.length > EXPORT_MAX_CHARS) error(400, 'That is too long to import at once.');
	const exported = parseExport(text);
	if (exported) return json({ ...exported, from: 'export' });
	if (text.length > PARSE_MAX_CHARS) {
		error(400, `Text that is not a Profile export is read ${PARSE_MAX_CHARS.toLocaleString('en-NZ')} characters at a time.`);
	}
	try {
		const draft = await parseIntoDraft(user.id, [{ label: 'Pasted text', about: 'anything', text }]);
		return json({ ...draft, from: 'text' });
	} catch (err) {
		if (err instanceof ProfileError) error(400, err.message);
		throw err;
	}
};
