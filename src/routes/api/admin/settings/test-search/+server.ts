import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/api';
import {
	DEFAULT_RESEARCH,
	DEFAULT_WEB_SEARCH,
	getSetting,
	type ResearchSettings,
	type WebSearchSettings
} from '$lib/server/settings';
import {
	SearchProviderError,
	braveAlternatives,
	languageSupport,
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

	// The configured language codes, read the way the provider will read them.
	// An unsupported code is not an error — the search still runs, just without
	// the constraint — but it is worth saying, because nothing else ever would.
	const research = getSetting<ResearchSettings>('research', DEFAULT_RESEARCH);
	const configured = languageSupport(
		cfg.provider,
		[cfg.defaultLanguage ?? '', research.extraLanguages ?? ''].filter(Boolean).join(',')
	);
	const unsupported = configured
		.filter((l) => !l.sentAs)
		.map((l) => {
			const near = cfg.provider === 'brave' ? braveAlternatives(l.code) : [];
			return near.length ? `${l.code} (${cfg.provider} uses ${near.join(' or ')})` : l.code;
		});
	const languageWarning = unsupported.length
		? `${cfg.provider} cannot filter by ${unsupported.join(', ')}. Searches tagged with those run without a language constraint.`
		: null;

	const started = Date.now();
	try {
		const outcome = await runWebSearch(PROBE_QUERY, cfg);
		emitEvent({
			userId: admin.id,
			type: 'admin',
			name: 'websearch.test',
			status: 'ok',
			durationMs: Date.now() - started,
			detail: {
				provider: outcome.provider,
				results: outcome.results.length,
				...(outcome.degraded ? { unresponsiveEngines: outcome.degraded.engines } : {})
			}
		});
		return json({
			ok: true,
			provider: outcome.provider,
			results: outcome.results.length,
			durationMs: Date.now() - started,
			failedOver: outcome.failedOver ?? null,
			// Which engines did not answer, when the provider says. This used to
			// be a guess ("may be silently rate-limiting") purely because nothing
			// read the diagnosis the provider was already sending.
			unresponsiveEngines: outcome.degraded?.engines ?? null,
			languageWarning,
			warning: outcome.degraded
				? `Answered, but these engines did not: ${outcome.degraded.engines.join(', ')}. Results are incomplete.`
				: outcome.results.length === 0
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
		return json({ ok: false, durationMs: Date.now() - started, languageWarning, ...detail });
	}
};
