import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin, requireUser } from '$lib/server/api';
import { deleteSkill, getSkill, saveSkill, setSkillEnabled, setSkillOwner } from '$lib/server/skills';
import { emitEvent } from '$lib/server/engine/events';

export const GET: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	// Someone else's personal skill is not found, exactly like a missing one.
	const skill = getSkill(params.name, user.isAdmin ? undefined : user.id);
	if (!skill) error(404, 'Skill not found');
	return json(skill);
};

export const PUT: RequestHandler = async ({ locals, params, request }) => {
	const admin = requireAdmin(locals);
	const existing = getSkill(params.name);
	if (!existing) error(404, 'Skill not found');
	const body = await request.json().catch(() => ({}));

	if (typeof body.enabled === 'boolean' && Object.keys(body).length === 1) {
		setSkillEnabled(params.name, body.enabled);
		return json({ ok: true });
	}
	// Sharing only widens: a shared skill may be in use by anyone, so taking
	// one back to a single owner is not offered.
	if (body.shared === true && Object.keys(body).length === 1) {
		setSkillOwner(params.name, null);
		emitEvent({ userId: admin.id, type: 'admin', name: `skill.share ${params.name}`, status: 'ok' });
		return json({ ok: true });
	}

	const skill = saveSkill({
		name: existing.meta.name,
		category: String(body.category ?? existing.meta.category),
		description: String(body.description ?? existing.meta.description),
		triggers: String(body.triggers ?? existing.meta.triggers),
		tasks: String(body.tasks ?? existing.meta.tasks),
		author: existing.meta.author,
		body: typeof body.body === 'string' ? body.body : existing.body,
		enabled: typeof body.enabled === 'boolean' ? body.enabled : existing.meta.enabled
	});
	emitEvent({
		userId: admin.id,
		type: 'admin',
		name: `skill.save ${skill.name}`,
		status: 'ok',
		detail: { version: skill.version }
	});
	return json(skill);
};

export const DELETE: RequestHandler = ({ locals, params }) => {
	const admin = requireAdmin(locals);
	if (!deleteSkill(params.name)) error(404, 'Skill not found');
	emitEvent({ userId: admin.id, type: 'admin', name: `skill.delete ${params.name}`, status: 'ok' });
	return json({ ok: true });
};
