import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/api';
import { encryptSecret } from '$lib/server/crypto';
import {
	DEFAULT_BUDGET,
	DEFAULT_COMPACTION,
	DEFAULT_MEMORY,
	DEFAULT_WEB_SEARCH,
	getSetting,
	setSetting
} from '$lib/server/settings';
import { emitEvent } from '$lib/server/engine/events';

const KNOWN_KEYS = ['websearch', 'compaction', 'budget', 'github', 'memory'] as const;
const DEFAULTS: Record<string, unknown> = {
	websearch: DEFAULT_WEB_SEARCH,
	compaction: DEFAULT_COMPACTION,
	budget: DEFAULT_BUDGET,
	github: {},
	memory: DEFAULT_MEMORY
};

// Fields the UI submits in plaintext that are stored encrypted. An empty
// string means "keep the existing secret"; null clears it.
const SECRET_FIELDS: Record<string, { plain: string; enc: string }[]> = {
	websearch: [{ plain: 'apiKey', enc: 'apiKeyEnc' }],
	github: [{ plain: 'token', enc: 'tokenEnc' }]
};

export const GET: RequestHandler = ({ locals }) => {
	requireAdmin(locals);
	const out: Record<string, unknown> = {};
	for (const key of KNOWN_KEYS) {
		const value = { ...(DEFAULTS[key] as object), ...getSetting<object>(key, {}) } as Record<
			string,
			unknown
		>;
		for (const field of SECRET_FIELDS[key] ?? []) {
			value[`has${cap(field.plain)}`] = Boolean(value[field.enc]);
			delete value[field.enc];
		}
		out[key] = value;
	}
	return json(out);
};

export const PUT: RequestHandler = async ({ locals, request }) => {
	const admin = requireAdmin(locals);
	const body = await request.json().catch(() => ({}));
	const key = body.key as string;
	if (!KNOWN_KEYS.includes(key as (typeof KNOWN_KEYS)[number])) {
		error(400, `Unknown settings key: ${key}`);
	}
	const existing = getSetting<Record<string, unknown>>(key, {});
	const incoming = { ...(DEFAULTS[key] as object), ...(body.value ?? {}) } as Record<
		string,
		unknown
	>;

	for (const field of SECRET_FIELDS[key] ?? []) {
		const plain = incoming[field.plain];
		delete incoming[field.plain];
		delete incoming[`has${cap(field.plain)}`];
		if (typeof plain === 'string' && plain) {
			incoming[field.enc] = encryptSecret(plain);
		} else if (plain === null) {
			delete incoming[field.enc];
		} else if (existing[field.enc]) {
			incoming[field.enc] = existing[field.enc];
		}
	}

	setSetting(key, incoming);
	emitEvent({ userId: admin.id, type: 'admin', name: `settings.${key}`, status: 'ok' });
	return json({ ok: true });
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
