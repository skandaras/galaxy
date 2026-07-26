import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/api';
import { DEFAULT_WEB_SEARCH, getSetting, type WebSearchSettings } from '$lib/server/settings';
import {
	SearchProviderError,
	runWebSearch,
	webSearchConfigured
} from '$lib/server/engine/tools/web-search';
import { emitEvent } from '$lib/server/engine/events';

const PROBE_QUERY = 'galaxy spiral arms';

/**
 * Run one real search through the saved settings and report exactly what came
 * back. Search failures are otherwise only visible mid-conversation, where the
 * agent can only guess at the cause — this answers it in one click, on the
 * machine that actually has the network path.
 */
export const POST: RequestHandler = async ({ locals }) => {
	const admin = requireAdmin(locals);
	const cfg = getSetting<WebSearchSettings>('websearch', DEFAULT_WEB_SEARCH);

	if (!webSearchConfigured(cfg)) {
		return json({
			ok: false,
			provider: cfg.provider,
			reason:
				cfg.provider === 'none'
					? 'No provider selected.'
					: `${cfg.provider} is selected but not configured (missing API key or instance URL).`
		});
	}

	const started = Date.now();
	try {
		const outcome = await runWebSearch(PROBE_QUERY, cfg);
		emitEvent({
			userId: admin.id,
			type: 'admin',
			name: 'websearch.test',
			status: 'ok',
			durationMs: Date.now() - started,
			detail: { provider: outcome.provider, results: outcome.results.length }
		});
		return json({
			ok: true,
			provider: outcome.provider,
			results: outcome.results.length,
			durationMs: Date.now() - started,
			failedOver: outcome.failedOver ?? null,
			// A configured provider that returns zero for this query is suspicious
			// even though it is not technically an error.
			warning:
				outcome.results.length === 0
					? 'The provider answered but returned no results for a generic query — it may be silently rate-limiting.'
					: null,
			sample: outcome.results.slice(0, 3).map((r) => ({ title: r.title, url: r.url }))
		});
	} catch (err) {
		const detail =
			err instanceof SearchProviderError
				? { provider: err.provider, reason: err.reason, status: err.status, bytes: err.bytes }
				: { provider: cfg.provider, reason: String(err) };
		emitEvent({
			userId: admin.id,
			type: 'admin',
			name: 'websearch.test',
			status: 'error',
			durationMs: Date.now() - started,
			detail
		});
		return json({ ok: false, durationMs: Date.now() - started, ...detail });
	}
};
