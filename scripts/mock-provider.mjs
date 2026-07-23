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
		res.end(JSON.stringify({ data: [MODEL] }));
		return;
	}

	if (req.method === 'GET' && url.pathname === '/searxng/search') {
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(
			JSON.stringify({
				results: [
					{
						title: 'Mock result one',
						url: 'https://example.com/one',
						content: `Snippet about ${url.searchParams.get('q')}`
					},
					{ title: 'Mock result two', url: 'https://example.com/two', content: 'More detail.' }
				]
			})
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

		res.writeHead(200, {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache'
		});

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
			if (system.includes('PLAN mode')) {
				if (toolResults === 0) call('list_files', {});
				else {
					delta(res, { content: 'Plan: 1. Add a description line to README.md 2. Commit and push.' });
					delta(res, {}, 'stop');
				}
			} else {
				if (toolResults === 0) call('read_file', { path: 'README.md' });
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
