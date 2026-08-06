import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { addMember, listMembers, removeMember } from '$lib/server/boards';

export const GET: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	const members = listMembers(params.id, user.id);
	if (!members) error(404, 'Board not found');
	return json(members);
};

export const POST: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	if (!listMembers(params.id, user.id)) error(404, 'Board not found');
	const body = await request.json().catch(() => ({}));
	const username = typeof body.username === 'string' ? body.username : '';
	if (!username.trim()) error(400, 'username is required');

	const result = addMember(params.id, user.id, username);
	if (!result.ok) {
		if (result.reason === 'forbidden') error(403, 'Only the board owner can invite people');
		if (result.reason === 'already-member') error(409, `${username} is already on this board`);
		// Accounts appear in Galaxy the first time they sign in through Authelia,
		// so an invite before that first login has nobody to attach to.
		error(404, `No user called "${username}" — they need to sign in to Galaxy at least once first`);
	}
	return json(result.member, { status: 201 });
};

export const DELETE: RequestHandler = ({ locals, params, url }) => {
	const user = requireUser(locals);
	if (!listMembers(params.id, user.id)) error(404, 'Board not found');
	const target = url.searchParams.get('userId');
	if (!target) error(400, 'userId is required');
	if (!removeMember(params.id, user.id, target)) {
		error(403, 'Only the board owner can remove members, and the owner cannot be removed');
	}
	return json({ ok: true });
};
