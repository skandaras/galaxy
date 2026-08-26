import type {
	CacheMode,
	ChatRequest,
	MessageContent,
	ProviderAdapter,
	ProviderMessage,
	RemoteModel,
	StreamEvent,
	ToolCall,
	Usage
} from './types';
import { ProviderHttpError } from './types';

// The OpenAI-compatible chat-completions protocol is the de-facto lingua
// franca — OpenRouter, local endpoints, and most gateways speak it. This one
// adapter is therefore the whole provider layer for now; anything exotic can
// implement ProviderAdapter beside it.

export interface OpenAiCompatOptions {
	baseUrl: string;
	apiKey?: string;
	extraHeaders?: Record<string, string>;
}

export function createOpenAiCompatAdapter(opts: OpenAiCompatOptions): ProviderAdapter {
	const headers = (): Record<string, string> => ({
		'content-type': 'application/json',
		...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
		...opts.extraHeaders
	});

	const body = (req: ChatRequest, stream: boolean) => ({
		model: req.modelKey,
		messages: withCacheBreakpoints(req.messages, req.cacheMode).map((m) => ({
			role: m.role,
			content: m.content,
			...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
			...(m.tool_calls?.length
				? {
						tool_calls: m.tool_calls.map((t) => ({
							id: t.id,
							type: 'function',
							function: { name: t.name, arguments: t.arguments }
						}))
					}
				: {})
		})),
		...(req.tools?.length
			? {
					tools: req.tools.map((t) => ({
						type: 'function',
						function: { name: t.name, description: t.description, parameters: t.parameters }
					}))
				}
			: {}),
		...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
		...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
		stream,
		...(stream ? { stream_options: { include_usage: true } } : {})
	});

	async function post(req: ChatRequest, stream: boolean, signal?: AbortSignal) {
		const res = await fetch(`${opts.baseUrl}/chat/completions`, {
			method: 'POST',
			headers: headers(),
			body: JSON.stringify(body(req, stream)),
			signal
		});
		if (!res.ok) {
			const text = await res.text().catch(() => '');
			throw new ProviderHttpError(res.status, `Provider ${res.status}: ${text.slice(0, 500)}`);
		}
		return res;
	}

	return {
		async *stream(req, signal) {
			const res = await post(req, true, signal);
			if (!res.body) throw new Error('Provider returned no body');
			yield* parseChatCompletionStream(res.body);
		},

		async complete(req, signal) {
			const res = await post(req, false, signal);
			const data = await res.json();
			const choice = data.choices?.[0];
			const text = choice?.message?.content ?? '';
			// Reasoning models put chain-of-thought on its own field and leave
			// content empty when the budget runs out mid-thought.
			const reasoning =
				choice?.message?.reasoning_content ?? choice?.message?.reasoning ?? '';
			return {
				text,
				finishReason: choice?.finish_reason ?? null,
				reasonedOnly: !text && Boolean(reasoning),
				usage: data.usage
					? {
							promptTokens: data.usage.prompt_tokens ?? 0,
							completionTokens: data.usage.completion_tokens ?? 0
						}
					: null
			};
		},

		async listModels(signal) {
			const res = await fetch(`${opts.baseUrl}/models`, { headers: headers(), signal });
			if (!res.ok) throw new ProviderHttpError(res.status, `Model listing failed: ${res.status}`);
			const data = await res.json();
			const rows: unknown[] = Array.isArray(data.data) ? data.data : [];
			return rows.map((raw) => toRemoteModel(raw as Record<string, unknown>));
		}
	};
}

/**
 * Mark the cache breakpoints a provider needs told about explicitly.
 *
 * Most endpoints cache on their own off a stable prefix and need nothing from
 * us — that is what `auto` means, and it is the default. Anthropic and Gemini
 * do not: they cache only up to a `cache_control` marker, which OpenRouter
 * passes through in the content part it sits on.
 *
 * Two breakpoints, which is the shape that pays: the system message, the
 * largest thing that never changes within a run, and the newest settled
 * message, so each round-trip extends the cached prefix rather than restarting
 * it. The final message is deliberately left outside — it is the one that
 * changed, and there is nothing to reuse behind it.
 *
 * Only plain, non-empty string content is marked. A tool result or an assistant
 * message holding tool calls carries structure that not every gateway will
 * accept rewritten into a content-part array, and a marker is never worth
 * risking the call itself over.
 *
 * Exported for tests.
 */
export function withCacheBreakpoints(
	messages: ProviderMessage[],
	mode: CacheMode | undefined
): ProviderMessage[] {
	if (mode !== 'explicit' || !messages.length) return messages;

	const markable = (i: number) => {
		const m = messages[i];
		return (
			(m.role === 'system' || m.role === 'user' || m.role === 'assistant') &&
			typeof m.content === 'string' &&
			m.content.length > 0
		);
	};

	const at = new Set<number>();
	if (markable(0)) at.add(0);
	for (let i = messages.length - 2; i > 0; i--) {
		if (markable(i)) {
			at.add(i);
			break;
		}
	}
	if (!at.size) return messages;

	return messages.map((m, i) =>
		at.has(i)
			? {
					...m,
					content: [
						{ type: 'text', text: m.content as string, cache_control: { type: 'ephemeral' } }
					] as unknown as MessageContent
				}
			: m
	);
}

/**
 * Read one `usage` payload, including whatever it says about caching.
 *
 * Cache activity used to be dropped on the floor here, which made prompt
 * caching unfalsifiable: there was no way to tell a provider serving a cached
 * prefix from one that had never cached anything. Both cache fields stay
 * optional on the way out, because "the provider said nothing" and "nothing
 * was cached" are different answers and only one of them is zero.
 */
export function readUsage(raw: Record<string, unknown>): Usage {
	const num = (v: unknown): number | undefined =>
		typeof v === 'number' && Number.isFinite(v) ? v : undefined;
	const details = (raw.prompt_tokens_details ?? {}) as Record<string, unknown>;
	const cached = num(details.cached_tokens);
	const discount = num(raw.cache_discount);
	return {
		promptTokens: num(raw.prompt_tokens) ?? 0,
		completionTokens: num(raw.completion_tokens) ?? 0,
		...(cached !== undefined ? { cachedPromptTokens: cached } : {}),
		...(discount !== undefined ? { cacheDiscountUsd: discount } : {})
	};
}

/** Map one entry of GET /models to our registry shape (OpenRouter-style fields optional). */
function toRemoteModel(m: Record<string, unknown>): RemoteModel {
	const pricing = (m.pricing ?? {}) as Record<string, unknown>;
	const architecture = (m.architecture ?? {}) as Record<string, unknown>;
	const supported = (m.supported_parameters ?? []) as unknown[];
	const modalities = (architecture.input_modalities ?? []) as unknown[];
	const perTok = (v: unknown): number | null => {
		const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
		return Number.isFinite(n) ? n * 1_000_000 : null;
	};
	return {
		key: String(m.id),
		displayName: typeof m.name === 'string' && m.name ? m.name : String(m.id),
		contextWindow: typeof m.context_length === 'number' ? m.context_length : null,
		supportsTools: supported.includes('tools'),
		supportsVision: modalities.includes('image'),
		promptCostPerMTok: perTok(pricing.prompt),
		completionCostPerMTok: perTok(pricing.completion),
		cacheMode: defaultCacheMode(String(m.id))
	};
}

/**
 * A starting guess at how a model wants caching asked for, used only when a
 * model is first imported — an admin's later choice is never overwritten.
 *
 * Nothing in an OpenAI-compatible /models listing describes caching, so this
 * reads the one signal there is: the vendor prefix OpenRouter puts on a model
 * id. Anthropic and Gemini cache only up to an explicit breakpoint; everyone
 * else either caches on their own or not at all, and 'auto' sends nothing
 * either way.
 *
 * Exported for tests.
 */
export function defaultCacheMode(modelKey: string): CacheMode {
	return /^(anthropic|google)\//i.test(modelKey) ? 'explicit' : 'auto';
}

/**
 * Parse an OpenAI-compatible SSE stream into StreamEvents. Tool-call argument
 * fragments arrive spread across chunks, keyed by index; they are accumulated
 * and emitted once complete.
 */
export async function* parseChatCompletionStream(
	stream: ReadableStream<Uint8Array>
): AsyncGenerator<StreamEvent> {
	const pendingCalls = new Map<number, { id: string; name: string; args: string }>();
	let usage: Usage | null = null;
	let finishReason: string | null = null;
	let sawToolCallFinish = false;

	for await (const line of sseLines(stream)) {
		// Anything that is not a data line is the gateway saying it is still
		// there — OpenRouter sends `: OPENROUTER PROCESSING` comments through a
		// long upstream wait. These used to be dropped before the parser ever saw
		// them, which is exactly the silence the idle watchdog was killing runs
		// for.
		if (!line.startsWith('data:')) {
			yield { type: 'progress' };
			continue;
		}
		const data = line.slice(5).trim();
		if (data === '[DONE]') break;
		let chunk: Record<string, unknown>;
		try {
			chunk = JSON.parse(data);
		} catch {
			// Real bytes we could not read. Still evidence the connection is alive.
			yield { type: 'progress' };
			continue;
		}
		const u = chunk.usage as Record<string, unknown> | undefined;
		if (u) usage = readUsage(u);

		const choice = (chunk.choices as Record<string, unknown>[] | undefined)?.[0];
		if (!choice) {
			// A usage-only or otherwise choice-less chunk.
			yield { type: 'progress' };
			continue;
		}
		const delta = (choice.delta ?? {}) as Record<string, unknown>;

		if (typeof delta.content === 'string' && delta.content) {
			yield { type: 'text', delta: delta.content };
		}
		// Reasoning arrives on its own field — `reasoning_content` on
		// DeepSeek/vLLM/Ollama, `reasoning` on OpenRouter — and spends the same
		// token budget as the answer. Dropping it entirely (the old behaviour)
		// made a model that thought until its cap look like it returned nothing.
		const reasoning = delta.reasoning_content ?? delta.reasoning;
		if (typeof reasoning === 'string' && reasoning) {
			yield { type: 'reasoning', delta: reasoning };
		}
		const toolCalls = delta.tool_calls as
			| { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]
			| undefined;
		if (toolCalls) {
			for (const tc of toolCalls) {
				const idx = tc.index ?? 0;
				const entry = pendingCalls.get(idx) ?? { id: '', name: '', args: '' };
				if (tc.id) entry.id = tc.id;
				if (tc.function?.name) entry.name += tc.function.name;
				if (tc.function?.arguments) entry.args += tc.function.arguments;
				pendingCalls.set(idx, entry);
			}
			// The batch is only emitted once the stream ends, so without this the
			// whole of a tool call is invisible to the watchdog — and a coding
			// model's longest output is a write_file payload, streamed one
			// fragment at a time over a minute or more.
			yield { type: 'progress' };
		}
		if (typeof choice.finish_reason === 'string') {
			finishReason = choice.finish_reason;
			if (finishReason === 'tool_calls') sawToolCallFinish = true;
		}
	}

	if ((sawToolCallFinish || pendingCalls.size) && pendingCalls.size) {
		const calls: ToolCall[] = [...pendingCalls.entries()]
			.sort(([a], [b]) => a - b)
			.map(([i, c]) => ({ id: c.id || `call_${i}`, name: c.name, arguments: c.args || '{}' }));
		yield { type: 'tool_calls', calls };
	}
	if (usage) yield { type: 'usage', usage };
	yield { type: 'done', finishReason };
}

/**
 * Every non-empty line of an SSE stream, `data:` or not.
 *
 * It used to yield only the payload of `data:` lines and drop the rest on the
 * floor. Comment lines are how a gateway says "still working" — the one signal
 * that distinguishes a slow upstream from a dead connection — so the caller
 * gets everything and decides.
 */
async function* sseLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			for (const line of lines) {
				const trimmed = line.trim();
				if (trimmed) yield trimmed;
			}
		}
	} finally {
		reader.releaseLock();
	}
}
