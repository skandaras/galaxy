// Mock OpenAI-compatible provider + SearXNG endpoint for local verification
// and CI smoke tests. No real model anywhere near this.
//
//   node scripts/mock-provider.mjs [port]
//
// GET  /v1/models            → one tool-capable mock model, plus a painter
// POST /v1/chat/completions  → streams text; emits a web_search tool call
//                              when tools are offered and no tool result yet
// GET  /searxng/search       → canned results (format=json)
//
// MOCK_SLOW_TITLE=1 delays the chat-title reply by 2.5s. Titling runs after the
// reply lands, so an instant local answer hides whether the UI ever picks the
// new name up — set this when checking that by hand.

import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 39400);

/**
 * Consolidations already refused, for questions asking to be refused.
 *
 * Keyed off the question rather than an env var so one mock instance serves
 * both the ordinary research checks and the flaky one in the same smoke run.
 */
let firstConsolidations = 0;

const MODEL = {
	id: 'mock/orion-1',
	name: 'Orion 1 (mock)',
	context_length: 8192,
	pricing: { prompt: '0.000001', completion: '0.000002' },
	supported_parameters: ['tools'],
	architecture: { input_modalities: ['text', 'image'] }
};

// A reasoning model that emits only `reasoning_content` and spends its whole
// token budget doing so — the shape that made deep research return nothing.
const REASONING_MODEL = {
	id: 'mock/ponder-1',
	name: 'Ponder 1 (mock reasoning)',
	context_length: 8192,
	pricing: { prompt: '0.000001', completion: '0.000002' },
	supported_parameters: ['tools', 'reasoning'],
	architecture: { input_modalities: ['text'] }
};

// A model that draws. OpenRouter reports the capability as an output modality
// and returns the picture on message.images, which is the shape generate_image
// reads — so a mock that only streamed text would prove nothing about it.
const PAINTER_MODEL = {
	id: 'mock/painter-1',
	name: 'Painter 1 (mock image)',
	context_length: 8192,
	pricing: { prompt: '0.000001', completion: '0.000002' },
	supported_parameters: [],
	architecture: { input_modalities: ['text', 'image'], output_modalities: ['text', 'image'] }
};

/** A 1×1 PNG: the smallest thing that is genuinely an image file. */
const PIXEL_PNG =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const isReasoning = (modelKey) => String(modelKey ?? '').includes('ponder');
const isPainter = (modelKey) => String(modelKey ?? '').includes('painter');

function sseChunk(res, obj) {
	res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function delta(res, d, finish = null) {
	sseChunk(res, {
		id: 'mock',
		object: 'chat.completion.chunk',
		choices: [{ index: 0, delta: d, finish_reason: finish }]
	});
}

/**
 * The canned reply for a prompt one of the suites scripts by marker, or null
 * when nothing matches and the caller should behave normally.
 *
 * Shared by both request paths deliberately. Framing, planning and
 * consolidation moved from complete() to streaming when their flat deadline
 * became an idle one, and this chain used to live inside the non-streaming
 * branch — so the moment they moved, every one of them was answered with
 * "Mock completion." and the whole research suite failed at once.
 */
async function scriptedReply(userText, maxTokens = 0) {
	let content = null;
	// Set by a branch that models generation being cut off rather than finishing.
	let stoppedOnLength = false;
		if (userText.includes('RESEARCH-FRAME')) {
			// Echoes the subject from the conversation, so a test can prove the
			// follow-up was resolved against it rather than researched literally.
			content = JSON.stringify({
				question: userText.includes('nebulae')
					? 'How do nebulae form, focusing on helium content?'
					: 'A standalone research question',
				background: 'Earlier turns already covered formation.'
			});
		} else if (userText.includes('RESEARCH-TRIAGE')) {
			content = JSON.stringify({ open: [1, 2] });
		} else if (userText.includes('RESEARCH-PLAN')) {
			content = JSON.stringify({ queries: ['nebula formation', 'nebula composition'] });
		} else if (userText.includes('RESEARCH-CONSOLIDATE')) {
			// Scripted to exercise the narrowing the loop exists for: the first
			// round establishes something and names a gap to chase, and the
			// round after that calls it done. Keyed off the round header in the
			// prompt, so it works whatever the effort level allows.
			const first = /RESEARCH-CONSOLIDATE — round 1 of/.test(userText);
			// Refuse the first *two* calls, so both recovery layers are exercised:
			// consolidate() retries with a larger allowance, and when that fails too
			// the round itself is retried. Round one has no brief yet and so no open
			// gaps to continue from, which is why a single failure there used to end
			// the whole run rather than cost it one round.
			const flaky =
				first && userText.includes('FLAKY-CONSOLIDATION') && firstConsolidations++ < 2;
			// A brief cut off mid-JSON: what a real model does when the budget is
			// smaller than the brief the prompt asks for. Only on the smaller of the
			// two allowances, so asking again with room is what fixes it.
			const cutOff = userText.includes('TRUNCATED-CONSOLIDATION') && maxTokens < 4000;
			// Stopped on length, as a real truncation is — the caller cannot tell it
			// apart from a short answer otherwise.
			if (cutOff) stoppedOnLength = true;
			content = flaky
				? 'sorry, I cannot produce that'
				: cutOff
				? '{"findings":[{"claim":"Nebulae form from collapsing molecular clouds","sources":[1]},{"claim":"a second finding that stops mid-sen'
				: first
				? JSON.stringify({
						findings: [{ claim: 'Nebulae form from collapsing molecular clouds', sources: [1] }],
						gaps: ['what proportion of a nebula is helium'],
						conflicts: [],
						sufficient: false,
						next_queries: [{ q: 'nebula helium fraction', language: '' }]
					})
				: JSON.stringify({
						findings: [
							{ claim: 'Nebulae form from collapsing molecular clouds', sources: [1] },
							{ claim: 'Composition is roughly 90% hydrogen, 10% helium', sources: [2] }
						],
						gaps: [],
						conflicts: [],
						sufficient: true
					});
		} else if (userText.includes('--- BEGIN ENTRY ---')) {
			// Alignment assessment. Quotes are pulled out of the entry itself and
			// ids out of the prompt, because the parser drops any score whose
			// evidence is not verbatim and any principle id it does not
			// recognise — a canned reply would be silently discarded and the
			// smoke would pass while proving nothing.
			const entry = userText.split('--- BEGIN ENTRY ---')[1].split('--- END ENTRY ---')[0].trim();
			const quote = entry.split(/(?<=\.)\s+/)[0] ?? entry.slice(0, 60);
			const principleIds = [...userText.matchAll(/^- id: (\S+)$/gm)].map((m) => m[1]);
			const dimensionIds = [...userText.matchAll(/^### (\S+) — /gm)].map((m) => m[1]);
			content = JSON.stringify({
				care: false,
				rumination: false,
				confidence: 'medium',
				band: 'mixed',
				standing: 'MOCK-STANDING: honest about it after the fact',
				summary: 'A mock reading.',
				dimensions: dimensionIds.slice(0, 2).map((id, i) => ({
					id,
					score: i === 0 ? 2 : 4,
					evidence: quote,
					principles: principleIds.slice(0, 1),
					note: 'mock note'
				})),
				tensions:
					principleIds.length >= 2
						? [{ between: principleIds.slice(0, 2), chose: principleIds[1], note: 'mock trade-off' }]
						: [],
				gaps: principleIds.length
					? [{ principle: principleIds[0], observation: 'mock gap', evidence: quote }]
					: [],
				disengagement: ['euphemistic-labelling'],
				next_step: 'If it happens again, then say the true thing first.',
				question: 'What made the easy answer feel necessary?'
			});
		} else if (userText.includes('Recent readings, oldest first')) {
			const neglected = [...userText.matchAll(/^- (\S+) — /gm)].map((m) => m[1]);
			content = JSON.stringify({
				body: 'MOCK-LETTER\n\nA mock letter about the direction of travel.',
				highlights: ['steadier on honesty', 'presence still slipping'],
				neglected: neglected.slice(0, 1)
			});
		} else if (userText.includes('MEMORY-AUDIT')) {
			// Echo a marker drawn from the audited activity so a test can prove
			// each user's memory came from their own chats and nobody else's.
			const marker = userText.includes('alpha-topic')
				? 'ALPHA-MEM'
				: userText.includes('beta-topic')
					? 'BETA-MEM'
					: null;
			content = JSON.stringify({
				memories: [
					...(marker ? [{ kind: 'fact', content: `Observed marker ${marker}` }] : []),
					{ kind: 'preference', content: 'User prefers concise replies' },
					{ kind: 'fact', content: 'Prod restarts via systemctl restart galaxy' }
				],
				skill_candidates: [
					{
						name: 'release-checklist',
						category: 'ops',
						description: 'Steps to follow when releasing',
						triggers: 'release, deploy',
						body: '## Steps\n1. Back up the volume\n2. Promote dev to prod',
						rationale: 'Deployment steps recurred in recent activity'
					}
				]
			});
		} else if (userText.includes('CHAT-TITLE')) {
			// Titling happens after the reply, so a real (remote) model takes a
			// beat. Simulated here, because an instant local answer hides whether
			// the UI ever picks the new title up.
			if (process.env.MOCK_SLOW_TITLE) await new Promise((r) => setTimeout(r, 2500));
			// Deliberately decorated: the titler is expected to strip quotes and
			// a "Title:" prefix rather than store them.
			content = '"Title: Mock conversation name"';
		} else if (userText.includes('UX-AUDIT')) {
			// Echo back something only a reader of the real prompt could know,
			// so the smoke test can prove the audit was handed live telemetry
			// and the actual interface source. The titles are fixed on purpose:
			// running the audit twice must file these once and then recognise
			// them as already proposed.
			const sawComposer = userText.includes('class="composer"');
			const sawTelemetry = userText.includes('USAGE TELEMETRY');
			content = JSON.stringify({
				ideas: [
					{
						title: 'Explain why a run stopped',
						area: 'chat',
						severity: 'high',
						effort: 'm',
						problem: 'A cancelled run leaves no explanation behind.',
						proposal: 'Show the stop reason inline in the thread.',
						evidence: `telemetry:${sawTelemetry} composer-source:${sawComposer}`
					},
					{
						title: 'Make the model picker reachable on a phone',
						area: 'mobile',
						severity: 'medium',
						effort: 's',
						problem: 'The picker sits below the fold on a small screen.',
						proposal: 'Move it into the composer options row.',
						evidence: 'mock'
					}
				]
			});
		} else if (userText.includes('SKILL-OPTIMISE')) {
			content = JSON.stringify({
				skill_candidates: [
					{
						name: 'demo-skill',
						category: 'general',
						description: 'Demonstrates the skill system (clarified)',
						triggers: 'demo, example',
						body: '## When to use\n\nImproved by the optimiser.',
						rationale: 'Description was vague'
					}
				]
			});
		}
	return content === null ? null : { content, finishReason: stoppedOnLength ? 'length' : 'stop' };
}

const server = createServer(async (req, res) => {
	const url = new URL(req.url, `http://127.0.0.1:${port}`);

	if (req.method === 'GET' && url.pathname === '/v1/models') {
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ data: [MODEL, REASONING_MODEL, PAINTER_MODEL] }));
		return;
	}

	// The same canned results, optionally with an engine complaining that it is
	// being asked too often — which is what a real instance reported when a
	// round fired all its queries at once. `/searxng-ratelimited` exists so the
	// smoke can prove the run slows itself down instead of pressing on.
	if (
		req.method === 'GET' &&
		(url.pathname === '/searxng/search' || url.pathname === '/searxng-ratelimited/search')
	) {
		const rateLimited = url.pathname.startsWith('/searxng-ratelimited');
		if (rateLimited) {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(
				JSON.stringify({
					results: [
						{
							title: 'Mock result one',
							url: `http://127.0.0.1:${port}/page/one`,
							content: 'Snippet under a rate limit.'
						}
					],
					unresponsive_engines: [['brave', 'too many requests']]
				})
			);
			return;
		}
		res.writeHead(200, { 'content-type': 'application/json' });
		const q = url.searchParams.get('q');
		// The follow-up query returns the awkward pages: one that refuses the
		// fetch, one served as UTF-16, one whose prose is only in JSON-LD. Spread
		// across loopback hostnames because triage caps how much of a round any
		// one domain may take, and every mock page would otherwise be one site.
		if (String(q ?? '').includes('helium')) {
			res.end(
				JSON.stringify({
					results: [
						{
							title: 'Refuses robots',
							url: `http://127.0.0.1:${port}/blocked-page`,
							content: 'Snippet standing in for a page we may not read.'
						},
						{
							title: 'Served as UTF-16',
							url: `http://localhost:${port}/utf16-page`,
							content: 'Snippet about encodings.'
						},
						{
							title: 'Prose only in JSON-LD',
							url: `http://127.0.0.2:${port}/jsonld-page`,
							content: 'Snippet about structured data.'
						}
					]
				})
			);
			return;
		}
		res.end(
			JSON.stringify({
				results: [
					{
						title: 'Mock result one',
						url: `http://127.0.0.1:${port}/page/one?q=${encodeURIComponent(q ?? '')}`,
						content: `Snippet about ${q}`
					},
					{
						title: 'Mock result two',
						url: `http://127.0.0.1:${port}/page/two`,
						content: 'More detail.'
					}
				]
			})
		);
		return;
	}

	// A SearXNG whose engines are all down: HTTP 200, empty results, and the
	// diagnosis in `unresponsive_engines` — exactly what an instance with no
	// route to the internet returns for every query.
	if (req.method === 'GET' && url.pathname === '/searxng-enginesdown/search') {
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(
			JSON.stringify({
				results: [],
				unresponsive_engines: [
					['duckduckgo', 'DNS error'],
					['brave', 'DNS error']
				]
			})
		);
		return;
	}

	// A backend that refuses the language parameter and answers fine without it —
	// Brave's behaviour for a code outside its allowlist, which it rejects with a
	// 422 rather than an empty result. The retry that drops the constraint is
	// provider-agnostic, so it can be exercised through the configurable one.
	if (req.method === 'GET' && url.pathname === '/searxng-langreject/search') {
		if (url.searchParams.has('language')) {
			res.writeHead(422, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ detail: "Input should be 'ar', 'eu', … 'zh-hans', 'zh-hant'" }));
			return;
		}
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(
			JSON.stringify({
				results: [
					{ title: 'Unconstrained result', url: `http://127.0.0.1:${port}/page/one`, content: 'x' }
				]
			})
		);
		return;
	}

	// A "blocked" search backend: HTTP 200 with a bot-check body and no results
	// markup — exactly how DuckDuckGo refuses a datacenter IP.
	if (req.method === 'GET' && url.pathname === '/searxng-blocked/search') {
		res.writeHead(200, { 'content-type': 'text/html' });
		res.end('<html><body><h1>Unusual traffic detected</h1><p>anomaly</p></body></html>');
		return;
	}

	// A page that refuses a fetch outright, so the snippet fallback can be seen
	// carrying a real reason rather than one generic phrase.
	if (req.method === 'GET' && url.pathname === '/blocked-page') {
		res.writeHead(403, { 'content-type': 'text/html' });
		res.end('<html><body>Forbidden</body></html>');
		return;
	}

	// UTF-16, which used to decode to NULs and be rejected as binary content.
	if (req.method === 'GET' && url.pathname === '/utf16-page') {
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-16le' });
		res.end(
			Buffer.from(
				'\ufeff<html><body><p>Nebulae are born in collapsing clouds. UTF16-FACT confirmed.</p></body></html>',
				'utf16le'
			)
		);
		return;
	}

	// All the prose lives in JSON-LD, as on many news and product pages.
	if (req.method === 'GET' && url.pathname === '/jsonld-page') {
		res.writeHead(200, { 'content-type': 'text/html' });
		res.end(
			`<html><body><script type="application/ld+json">${JSON.stringify({
				'@type': 'NewsArticle',
				articleBody: `JSONLD-FACT confirmed. ${'Nebula composition detail. '.repeat(20)}`
			})}</script><div id="root"></div></body></html>`
		);
		return;
	}

	if (req.method === 'GET' && url.pathname.startsWith('/page/')) {
		res.writeHead(200, { 'content-type': 'text/html' });
		res.end(
			`<html><head><title>Mock page</title><style>body{}</style></head><body><script>var x=1;</script><h1>Mock page ${url.pathname}</h1><p>Nebulae are born in collapsing clouds. The secret evidence number is FACT-42.</p></body></html>`
		);
		return;
	}

	if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
		let body = '';
		for await (const chunk of req) body += chunk;
		const parsed = JSON.parse(body);
		const last = parsed.messages.at(-1);
		const system = String(parsed.messages[0]?.content ?? '');
		const offered = (name) =>
			Array.isArray(parsed.tools) && parsed.tools.some((t) => t.function?.name === name);
		const asksFor = (word) =>
			last?.role === 'user' && String(last.content).toLowerCase().includes(word);
		const wantsTool = offered('web_search') && asksFor('search');
		// Same shape as the search trigger above, for the drawing path: the agent
		// calls generate_image, which calls the painter model behind it.
		const wantsImage = offered('generate_image') && asksFor('draw');

		// A provider that is simply down. Checked before either path picks its
		// response headers — a 503 after the SSE headers are already out is an
		// ERR_HTTP_HEADERS_SENT that takes this process with it. Every attempt
		// fails, backup included, so the turn dies having produced nothing: the
		// case where the Observatory record is the only way to find out why.
		// Matched exactly, not by substring: the memory audit replays recent chat
		// text back through this same endpoint, so a substring trigger would make
		// every later audit fail too, purely because the word had been typed once.
		if (String(last?.content ?? '').trim() === 'DEAD-PROVIDER') {
			res.writeHead(503, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ error: { message: 'mock provider is down' } }));
			return;
		}

		// Non-streaming path (complete()): memory audit, skill optimiser,
		// compaction summaries, etc.
		if (!parsed.stream) {
			const userText = String(last?.content ?? '');
			// Image generation. Answered only when the caller actually asked for
			// the modality, so the mock also proves the request carried it.
			if (isPainter(parsed.model) && (parsed.modalities ?? []).includes('image')) {
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(
					JSON.stringify({
						id: 'mock',
						choices: [
							{
								index: 0,
								message: {
									role: 'assistant',
									content: 'Here is the picture you asked for.',
									images: [
										{
											type: 'image_url',
											image_url: { url: `data:image/png;base64,${PIXEL_PNG}` }
										}
									]
								},
								finish_reason: 'stop'
							}
						],
						usage: { prompt_tokens: 30, completion_tokens: 10 }
					})
				);
				return;
			}
			const content = (await scriptedReply(userText, parsed.max_tokens ?? 0))?.content ?? 'Mock completion.';
			res.writeHead(200, { 'content-type': 'application/json' });
			if (isReasoning(parsed.model)) {
				// Thinks first, answers second. With a small cap the whole budget
				// goes on thinking and content comes back empty, stopped on length —
				// which is what broke the research planner. Given real headroom the
				// same model answers normally.
				const cap = parsed.max_tokens ?? 300;
				const room = cap >= 1000;
				res.end(
					JSON.stringify({
						id: 'mock',
						choices: [
							{
								index: 0,
								message: {
									role: 'assistant',
									content: room ? content : '',
									reasoning_content: 'thinking '.repeat(20)
								},
								finish_reason: room ? 'stop' : 'length'
							}
						],
						usage: { prompt_tokens: 50, completion_tokens: room ? 120 : cap }
					})
				);
				return;
			}
			res.end(
				JSON.stringify({
					id: 'mock',
					choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
					usage: { prompt_tokens: 50, completion_tokens: 40 }
				})
			);
			return;
		}

		res.writeHead(200, {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache'
		});

		// A prompt one of the suites scripts by marker. Framing, planning and
		// consolidation arrive here now that they are bounded by silence rather
		// than by a flat deadline, and they want the same canned reply they got
		// from complete() — including the reasoning-model behaviour, so the
		// planner's retry is exercised rather than bypassed.
		const scripted = await scriptedReply(String(last?.content ?? ''), parsed.max_tokens ?? 0);
		if (scripted !== null) {
			const scriptedFinish = scripted.finishReason;
			const cap = parsed.max_tokens ?? 300;
			const thinks = isReasoning(parsed.model);
			// Same threshold the non-streaming path uses: a small budget goes
			// entirely on thinking and comes back empty, stopped on length.
			const room = !thinks || cap >= 1000;
			if (thinks) {
				for (let i = 0; i < 3; i++) delta(res, { reasoning_content: `step ${i} of thinking… ` });
			}
			if (room) delta(res, { content: scripted.content });
			delta(res, {}, room ? scriptedFinish : 'length');
			sseChunk(res, {
				id: 'mock',
				object: 'chat.completion.chunk',
				choices: [],
				usage: { prompt_tokens: 50, completion_tokens: room ? 40 : cap }
			});
			res.write('data: [DONE]\n\n');
			res.end();
			return;
		}

		// Reasoning model: streams `reasoning_content` only, never `content`, and
		// stops on length. Reproduces a run that burns its whole budget thinking
		// and hands back nothing to show.
		if (isReasoning(parsed.model)) {
			const cap = parsed.max_tokens ?? 2048;
			const room = cap >= 8000;
			for (let i = 0; i < 5; i++) {
				delta(res, { reasoning_content: `step ${i} of thinking… ` });
				await new Promise((r) => setTimeout(r, 10));
			}
			if (room) {
				for (const p of ['Nebulae form from collapsing gas clouds [1]. ', 'Thought it through first.']) {
					delta(res, { content: p });
					await new Promise((r) => setTimeout(r, 10));
				}
			}
			delta(res, {}, room ? 'stop' : 'length');
			sseChunk(res, {
				id: 'mock',
				object: 'chat.completion.chunk',
				choices: [],
				usage: { prompt_tokens: 50, completion_tokens: room ? 300 : cap }
			});
			res.write('data: [DONE]\n\n');
			res.end();
			return;
		}

		// Reading a link the user supplied, rather than searching for it. The
		// second pass echoes what came back, so the smoke can prove the page text
		// actually reached the model.
		const fetched = parsed.messages.find(
			(m) => m.role === 'tool' && String(m.content ?? '').includes('BEGIN CONTENT')
		);
		if (fetched) {
			delta(res, { content: `Read the page. Contains FACT-42: ${String(fetched.content).includes('FACT-42')}` });
			delta(res, {}, 'stop');
			res.write('data: [DONE]\n\n');
			res.end();
			return;
		}
		if (String(last?.content ?? '').startsWith('READ-THIS ')) {
			delta(res, {
				tool_calls: [
					{
						index: 0,
						id: 'call_fetch',
						function: {
							name: 'fetch_url',
							arguments: JSON.stringify({ url: String(last.content).slice('READ-THIS '.length).trim() })
						}
					}
				]
			});
			delta(res, {}, 'tool_calls');
			res.write('data: [DONE]\n\n');
			res.end();
			return;
		}

		// Scripted coding agent: sequence driven by how many tool results have
		// accumulated in this turn.
		if (system.includes('PLAN mode') || system.includes('IMPLEMENT mode')) {
			const toolResults = parsed.messages.filter((m) => m.role === 'tool').length;
			const call = (name, args) => {
				delta(res, {
					tool_calls: [
						{ index: 0, id: `call_${toolResults}`, function: { name, arguments: JSON.stringify(args) } }
					]
				});
				delta(res, {}, 'tool_calls');
			};

			// A coding turn that asks to search takes a separate path, so the smoke
			// can prove web_search is offered here — and genuinely withheld when the
			// toggle is off, which surfaces as the loop rejecting an unknown tool.
			const triedSearch = parsed.messages.some(
				(m) => Array.isArray(m.tool_calls) && m.tool_calls.some((tc) => tc.function?.name === 'web_search')
			);
			if (triedSearch) {
				delta(res, { content: 'Mock coding answer after searching.' });
				delta(res, {}, 'stop');
				res.write('data: [DONE]\n\n');
				res.end();
				return;
			}
			if (last?.role === 'user' && String(last.content).toLowerCase().includes('search')) {
				call('web_search', { query: 'galaxy news' });
				res.write('data: [DONE]\n\n');
				res.end();
				return;
			}
			if (system.includes('PLAN mode')) {
				if (toolResults === 0) call('list_files', {});
				else {
					delta(res, { content: 'Plan: 1. Add a description line to README.md 2. Commit and push.' });
					delta(res, {}, 'stop');
				}
			} else {
				// Prior assistant replies in the history mean this is a continuation
				// leg. The first leg's edits were checkpointed for us, so pick up at
				// the push rather than starting the sequence again — which is the
				// behaviour a resumed run is supposed to have.
				const priorLegs = parsed.messages.filter(
					(m) => m.role === 'assistant' && !m.tool_calls
				).length;
				if (priorLegs > 0) {
					if (toolResults === 0) call('git_push', {});
					else {
						delta(res, { content: 'Done: picked up after the step limit and pushed.' });
						delta(res, {}, 'stop');
					}
				} else if (toolResults === 0) {
					// A lead-in of the length a verbose model actually writes — well
					// past the old 200-character line, which used to send it to the
					// reply instead of onto the step. The smoke asserts it lands on
					// the step and stays out of the saved message.
					delta(res, {
						content:
							'Reading the README before I touch it, so the description I add ' +
							'matches the shape of what is already there rather than replacing ' +
							'a heading somebody wrote on purpose, and so the commit afterwards ' +
							'has something honest to say about what actually changed.'
					});
					call('read_file', { path: 'README.md' });
				}
				else if (toolResults === 1)
					call('write_file', {
						path: 'README.md',
						content: '# origin\n\nA repo improved by the Galaxy coding agent.\n'
					});
				else if (toolResults === 2) call('bash', { command: 'ls && git status --short' });
				else if (toolResults === 3) call('git_commit', { message: 'Add project description to README' });
				else if (toolResults === 4) call('git_push', {});
				else {
					delta(res, { content: 'Done: README updated, committed and pushed.' });
					delta(res, {}, 'stop');
				}
			}
			sseChunk(res, {
				id: 'mock',
				object: 'chat.completion.chunk',
				choices: [],
				usage: { prompt_tokens: 30, completion_tokens: 10 }
			});
			res.write('data: [DONE]\n\n');
			res.end();
			return;
		}

		// Deliberately slow stream, so a test can cancel mid-reply. Emits a word
		// every 250ms and stops early if the client drops the connection, which
		// is how the abort is observed from this side.
		if (String(last?.content ?? '').includes('SLOW-STREAM')) {
			let closed = false;
			res.on('close', () => (closed = true));
			for (let i = 1; i <= 40 && !closed; i++) {
				delta(res, { content: `word${i} ` });
				await new Promise((r) => setTimeout(r, 250));
			}
			if (!closed) {
				delta(res, {}, 'stop');
				res.write('data: [DONE]\n\n');
				res.end();
			}
			return;
		}

		// Research synthesis: streamed answer citing the provided sources.
		if (String(last?.content ?? '').includes('RESEARCH-SYNTHESIS')) {
			const hasEvidence = String(last.content).includes('FACT-42');
			const parts = [
				'Nebulae form from collapsing gas clouds [1]. ',
				`Evidence check: ${hasEvidence ? 'FACT-42 confirmed' : 'no page evidence'} [2].\n\n`,
				'```mermaid\ngraph TD; Cloud-->Collapse; Collapse-->Nebula;\n```'
			];
			for (const p of parts) {
				delta(res, { content: p });
				await new Promise((r) => setTimeout(r, 10));
			}
			delta(res, {}, 'stop');
			sseChunk(res, { id: 'mock', choices: [], usage: { prompt_tokens: 60, completion_tokens: 30 } });
			res.write('data: [DONE]\n\n');
			res.end();
			return;
		}

		// Reports whether the system prompt carried a note about the previous
		// attempt — the thing that stops a follow-up blindly re-running a turn
		// that already failed.
		if (String(last?.content ?? '').includes('echo-prior')) {
			// Scanned across every message, not just the system prompt: the note is
			// carried as a tail note now so it cannot invalidate the cacheable
			// prefix. What matters to the test is that the turn was told, not where.
			const all = parsed.messages.map((x) => String(x.content ?? '')).join('\n');
			const m = all.match(/\[Previous attempt[^\]]*\]\n([^\n]*)/);
			delta(res, {
				content: `PRIORCHECK present=${all.includes('[Previous attempt')} says=${m ? m[1] : 'none'}`
			});
			delta(res, {}, 'stop');
			res.write('data: [DONE]\n\n');
			res.end();
			return;
		}

		// Library scoping: report which docs reached this user's system prompt.
		// The digest is what actually feeds another person's model, so this is
		// the check that matters rather than what the API happens to list.
		if (String(last?.content ?? '').includes('echo-lib')) {
			delta(res, {
				content: `LIBCHECK private=${system.includes('Alice Private')} shared=${system.includes('Team Notes')}`
			});
			delta(res, {}, 'stop');
			res.write('data: [DONE]\n\n');
			res.end();
			return;
		}

		// Bootstrap verification: report what the system prompt contained.
		if (String(last?.content ?? '').includes('echo-system')) {
			delta(res, {
				// ALPHA-MEM / BETA-MEM prove per-user memory isolation: a user's
				// prompt must contain their own marker and never the other's.
				content: `SYSCHECK skills=${system.includes('[Available skills')} library=${system.includes('[Library')} demo=${system.includes('demo-skill')} doc=${system.includes('Deploy Notes')} mem=${system.includes('[Memory')} pref=${system.includes('concise replies')} alpha=${system.includes('ALPHA-MEM')} beta=${system.includes('BETA-MEM')}`
			});
			delta(res, {}, 'stop');
			res.write('data: [DONE]\n\n');
			res.end();
			return;
		}

		// Skill-loading scenario: call skill_load, then echo the loaded body.
		if (String(last?.content ?? '').includes('load the skill')) {
			delta(res, {
				tool_calls: [
					{ index: 0, id: 'call_s', function: { name: 'skill_load', arguments: '{"name":"demo-skill"}' } }
				]
			});
			delta(res, {}, 'tool_calls');
			res.write('data: [DONE]\n\n');
			res.end();
			return;
		}
		const usedSkillLoad = parsed.messages.some(
			(m) => Array.isArray(m.tool_calls) && m.tool_calls.some((tc) => tc.function?.name === 'skill_load')
		);
		if (last?.role === 'tool' && usedSkillLoad) {
			delta(res, { content: `SKILL:${String(last.content).slice(0, 60)}` });
			delta(res, {}, 'stop');
			res.write('data: [DONE]\n\n');
			res.end();
			return;
		}

		// Boards reach the agent through the context bootstrap, so this reports
		// what actually landed in the system prompt rather than what the API lists.
		if (String(last?.content ?? '').includes('echo-board')) {
			delta(res, {
				content: `BOARDCHECK mine=${system.includes('Household')} theirs=${system.includes('Bob only')}`
			});
			delta(res, {}, 'stop');
			res.write('data: [DONE]\n\n');
			res.end();
			return;
		}

		// ask_user: the turn parks on the tool call until the browser answers,
		// then carries on with the answer as the tool result.
		const usedAsk = parsed.messages.some(
			(m) => Array.isArray(m.tool_calls) && m.tool_calls.some((tc) => tc.function?.name === 'ask_user')
		);
		if (String(last?.content ?? '').includes('ask-me') && !usedAsk) {
			delta(res, {
				tool_calls: [
					{
						index: 0,
						id: 'call_ask',
						function: {
							name: 'ask_user',
							arguments: JSON.stringify({ question: 'Which account?', options: ['Joint', 'Mine'] })
						}
					}
				]
			});
			delta(res, {}, 'tool_calls');
			res.write('data: [DONE]\n\n');
			res.end();
			return;
		}
		if (last?.role === 'tool' && usedAsk) {
			delta(res, { content: `ANSWERED:${String(last.content)}` });
			delta(res, {}, 'stop');
			res.write('data: [DONE]\n\n');
			res.end();
			return;
		}

		// The card hand-off: read the card, write to its Log, then report. Driven
		// by the seeded prompt the board sends, so this exercises the real path.
		const handoff = parsed.messages.find((m) =>
			String(m.content ?? '').includes('handing you a card from my task board')
		);
		if (handoff) {
			const cardId = String(handoff.content).match(/Its id is ([0-9a-f-]+)/)?.[1] ?? '';
			const called = (name) =>
				parsed.messages.some(
					(m) => Array.isArray(m.tool_calls) && m.tool_calls.some((tc) => tc.function?.name === name)
				);
			if (!called('card_read')) {
				delta(res, {
					tool_calls: [
						{ index: 0, id: 'call_cr', function: { name: 'card_read', arguments: JSON.stringify({ cardId }) } }
					]
				});
			} else if (!called('card_comment')) {
				delta(res, {
					tool_calls: [
						{
							index: 0,
							id: 'call_cc',
							function: {
								name: 'card_comment',
								arguments: JSON.stringify({ cardId, note: 'Rang them, waiting on a callback' })
							}
						}
					]
				});
			} else {
				delta(res, { content: 'CARD HANDLED' });
				delta(res, {}, 'stop');
				res.write('data: [DONE]\n\n');
				res.end();
				return;
			}
			delta(res, {}, 'tool_calls');
			res.write('data: [DONE]\n\n');
			res.end();
			return;
		}

		// Naming the chat from inside the turn — the primary path now. Driven by
		// the prompt note the engine injects while a chat is unnamed, so this
		// exercises the real condition rather than a magic word. Deliberately
		// last: that note is on the first turn of *every* new chat, so anywhere
		// earlier it swallows the turns the scenarios above stage.
		const namedAlready = parsed.messages.some(
			(m) => Array.isArray(m.tool_calls) && m.tool_calls.some((tc) => tc.function?.name === 'set_chat_title')
		);
		// A drawing turn is mid-flight on its second pass: the picture's link is
		// sitting in the tool result and has to reach the reply. Naming the chat
		// here would take that pass and lose it.
		const drewAlready = parsed.messages.some(
			(m) => Array.isArray(m.tool_calls) && m.tool_calls.some((tc) => tc.function?.name === 'generate_image')
		);
		if (
			system.includes('[This conversation has no name yet]') &&
			!namedAlready &&
			!wantsTool &&
			!wantsImage &&
			!drewAlready
		) {
			delta(res, {
				tool_calls: [
					{
						index: 0,
						id: 'call_title',
						function: {
							name: 'set_chat_title',
							arguments: JSON.stringify({ title: 'Named from the turn' })
						}
					}
				]
			});
			delta(res, {}, 'tool_calls');
			res.write('data: [DONE]\n\n');
			res.end();
			return;
		}

		if (wantsTool) {
			// Tool-call arguments intentionally split across chunks to exercise accumulation.
			delta(res, {
				tool_calls: [{ index: 0, id: 'call_1', function: { name: 'web_search', arguments: '' } }]
			});
			delta(res, { tool_calls: [{ index: 0, function: { arguments: '{"query": "gal' } }] });
			delta(res, { tool_calls: [{ index: 0, function: { arguments: 'axy news"}' } }] });
			delta(res, {}, 'tool_calls');
		} else if (wantsImage) {
			delta(res, {
				tool_calls: [
					{
						index: 0,
						id: 'call_img',
						function: {
							name: 'generate_image',
							arguments: JSON.stringify({ prompt: 'a spiral galaxy', name: 'galaxy' })
						}
					}
				]
			});
			delta(res, {}, 'tool_calls');
		} else if (last?.role === 'tool' && String(last.content ?? '').includes('](/api/chats/')) {
			// What a real model does with generate_image's result: it is told to
			// put the link in its reply verbatim, and the picture only reaches the
			// thread if it does.
			const link = String(last.content).match(/!?\[[^\]]*\]\(\/api\/chats\/[^)]+\)/)[0];
			for (const w of ['Here ', 'you ', 'are: ', link]) {
				delta(res, { content: w });
				await new Promise((r) => setTimeout(r, 10));
			}
			delta(res, {}, 'stop');
		} else if (last?.role === 'tool') {
			const words = ['Based ', 'on ', 'the ', 'search ', 'results: ', 'mock ', 'answer ', 'with ', 'sources.'];
			for (const w of words) {
				delta(res, { content: w });
				await new Promise((r) => setTimeout(r, 15));
			}
			delta(res, {}, 'stop');
		} else {
			const words = ['Hello ', 'from ', 'the ', 'mock ', 'model. '];
			for (const w of words) {
				delta(res, { content: w });
				await new Promise((r) => setTimeout(r, 15));
			}
			delta(res, {}, 'stop');
		}
		sseChunk(res, {
			id: 'mock',
			object: 'chat.completion.chunk',
			choices: [],
			usage: { prompt_tokens: 42, completion_tokens: 17 }
		});
		res.write('data: [DONE]\n\n');
		res.end();
		return;
	}

	res.writeHead(404);
	res.end('not found');
});

// All loopback addresses, not just 127.0.0.1: the research triage caps how much
// of a round one domain may take, so the fetch-variety pages above are served on
// several loopback hostnames to look like several sites.
server.listen(port, () => {
	console.log(`mock provider listening on http://127.0.0.1:${port}`);
});
