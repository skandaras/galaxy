import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/api';
import { db } from '$lib/server/db';
import { models } from '$lib/server/db/schema';

export const GET: RequestHandler = ({ locals }) => {
	requireAdmin(locals);
	return json(db.select().from(models).all());
};
