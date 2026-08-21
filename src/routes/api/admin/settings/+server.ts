import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/api';
import { encryptSecret } from '$lib/server/crypto';
import {
	DEFAULT_BOARDS,
	DEFAULT_BUDGET,
	DEFAULT_CODING,
	DEFAULT_COMPACTION,
	DEFAULT_FETCH,
	DEFAULT_MEMORY,
	DEFAULT_RESEARCH,
	DEFAULT_RETENTION,
	DEFAULT_UX_AUDIT,
	DEFAULT_WEB_SEARCH,
	getSetting,
	normaliseResearchSettings,
	normaliseWebSearchSettings,
	setSetting
} from '$lib/server/settings';
import { emitEvent } from '$lib/server/engine/events';

const KNOWN_KEYS = [
	'websearch',
	'compaction',
	'budget',
	'github',
	'memory',
	'research',
	'coding',
	'uxaudit',
	'retention',
	'fetch',
	'boards'
] as const;
const DEFAULTS: Record<string, unknown> = {
	websearch: DEFAULT_WEB_SEARCH,
	compaction: DEFAULT_COMPACTION,
	budget: DEFAULT_BUDGET,
	github: {},
	memory: DEFAULT_MEMORY,
	research: DEFAULT_RESEARCH,
	coding: DEFAULT_CODING,
	uxaudit: DEFAULT_UX_AUDIT,
	retention: DEFAULT_RETENTION,
	fetch: DEFAULT_FETCH,
	boards: DEFAULT_BOARDS
};

/**
 * Per-key clamping, applied on the way out as well as in.
 *
 * On PUT it is the only validation there is — the form's `min`/`max` attributes
 * do not survive a raw API call. On GET it is what stops a row saved before a
 * field existed from binding `undefined` into the form, which would then be
 * written straight back as null.
 *
 * A normaliser returns the whole object, so a key that also appears in
 * SECRET_FIELDS must carry its encrypted field through. `websearch` does both:
 * `normaliseWebSearchSettings` spreads the raw value before overriding the
 * numbers, which keeps `apiKeyEnc` (on the way out) and the plaintext `apiKey`
 * the loop below is about to consume (on the way in).
 */
const NORMALISERS: Record<string, (v: Record<string, unknown>) => Record<string, unknown>> = {
	research: (v) => normaliseResearchSettings(v) as unknown as Record<string, unknown>,
	websearch: (v) => normaliseWebSearchSettings(v) as unknown as Record<string, unknown>
};

/**
 * Fill a stored or submitted value out to a whole settings object.
 *
 * A normaliser is handed the **raw** value rather than one already merged over
 * the defaults, because merging first hides exactly what it needs to see: a row
 * written before a field existed would arrive carrying that field's default,
 * and the migration reading the older key it replaced would never fire. A
 * normaliser therefore owns its own defaulting; keys without one keep the plain
 * spread.
 */
function fill(key: string, value: Record<string, unknown>): Record<string, unknown> {
	return NORMALISERS[key]?.(value) ?? { ...(DEFAULTS[key] as object), ...value };
}

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
		const value = fill(key, getSetting<object>(key, {}) as Record<string, unknown>);
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
	const incoming = fill(key, (body.value ?? {}) as Record<string, unknown>);

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
