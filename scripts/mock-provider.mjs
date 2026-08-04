// Mock OpenAI-compatible provider + SearXNG endpoint for local verification
// and CI smoke tests. No real model anywhere near this.
//
//   node scripts/mock-provider.mjs [port]
//
// GET  /v1/models            → one tool-capable mock model
// POST /v1/chat/completions  → streams text; emits a web_search tool call
//                              when tools are offered and no tool result yet
// GET  /searxng/search       → canned results (format=json)

import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 39400);

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

const isReasoning = (modelKey) => String(modelKey ?? '').includes('ponder');

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

const server = createServer(async (req, res) => {
	const url = new URL(req.url, `http://127.0.0.1:${port}`);

	if (req.method === 'GET' && url.pathname === '/v1/models') {
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ data: [MODEL, REASONING_MODEL] }));
		return;
	}

	if (req.method === 'GET' && url.pathname === '/searxng/search') {
		res.writeHead(200, { 'content-type': 'application/json' });
		const q = url.searchParams.get('q');
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

	// A "blocked" search backend: HTTP 200 with a bot-check body and no results
	// markup — exactly how DuckDuckGo refuses a datacenter IP.
	if (req.method === 'GET' && url.pathname === '/searxng-blocked/search') {
		res.writeHead(200, { 'content-type': 'text/html' });
		res.end('<html><body><h1>Unusual traffic detected</h1><p>anomaly</p></body></html>');
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
		const wantsTool =
			Array.isArray(parsed.tools) &&
			parsed.tools.length &&
			last?.role === 'user' &&
			String(last.content).toLowerCase().includes('search');

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
			let content = 'Mock completion.';
			if (userText.includes('RESEARCH-PLAN')) {
				content = JSON.stringify({ queries: ['nebula formation', 'nebula composition'] });
			} else if (userText.includes('RESEARCH-REVIEW')) {
				content = JSON.stringify({ sufficient: true });
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
				} else if (toolResults === 0) call('read_file', { path: 'README.md' });
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
			const m = system.match(/\[Previous attempt[^\]]*\]\n([^\n]*)/);
			delta(res, {
				content: `PRIORCHECK present=${system.includes('[Previous attempt')} says=${m ? m[1] : 'none'}`
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

		if (wantsTool) {
			// Tool-call arguments intentionally split across chunks to exercise accumulation.
			delta(res, {
				tool_calls: [{ index: 0, id: 'call_1', function: { name: 'web_search', arguments: '' } }]
			});
			delta(res, { tool_calls: [{ index: 0, function: { arguments: '{"query": "gal' } }] });
			delta(res, { tool_calls: [{ index: 0, function: { arguments: 'axy news"}' } }] });
			delta(res, {}, 'tool_calls');
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

server.listen(port, '127.0.0.1', () => {
	console.log(`mock provider listening on http://127.0.0.1:${port}`);
});
