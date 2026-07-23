import { json } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { env } from '$env/dynamic/private';

export const GET = () => {
	try {
		db.run(sql`SELECT 1`);
		return json({ status: 'ok', env: env.GALAXY_ENV || 'dev' });
	} catch (e) {
		return json({ status: 'error', detail: String(e) }, { status: 503 });
	}
};
