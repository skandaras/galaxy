import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin, requireUser } from '$lib/server/api';
import { listSkills, saveSkill, SKILL_TEMPLATE } from '$lib/server/skills';
import { emitEvent } from '$lib/server/engine/events';

export const GET: RequestHandler = ({ locals }) => {
	requireUser(locals);
	return json({ skills: listSkills(), template: SKILL_TEMPLATE });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const admin = requireAdmin(locals);
	const body = await request.json().catch(() => ({}));
	if (typeof body.name !== 'string' || !body.name.trim()) error(400, 'name is required');
	try {
		const skill = saveSkill({
			name: body.name,
			category: String(body.category ?? 'general'),
			description: String(body.description ?? ''),
			triggers: String(body.triggers ?? ''),
			author: 'user',
			body: String(body.body ?? ''),
			enabled: body.enabled !== false
		});
		emitEvent({
			userId: admin.id,
			type: 'admin',
			name: `skill.save ${skill.name}`,
			status: 'ok',
			detail: { version: skill.version }
		});
		return json(skill, { status: 201 });
	} catch (err) {
		error(400, String(err instanceof Error ? err.message : err));
	}
};
