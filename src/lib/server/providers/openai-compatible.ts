import type {
	ChatRequest,
	ProviderAdapter,
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
		messages: req.messages.map((m) => ({
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
		completionCostPerMTok: perTok(pricing.completion)
	};
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

	for await (const data of sseDataLines(stream)) {
		if (data === '[DONE]') break;
		let chunk: Record<string, unknown>;
		try {
			chunk = JSON.parse(data);
		} catch {
			continue;
		}
		const u = chunk.usage as Record<string, number> | undefined;
		if (u) usage = { promptTokens: u.prompt_tokens ?? 0, completionTokens: u.completion_tokens ?? 0 };

		const choice = (chunk.choices as Record<string, unknown>[] | undefined)?.[0];
		if (!choice) continue;
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

async function* sseDataLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
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
				if (trimmed.startsWith('data:')) yield trimmed.slice(5).trim();
			}
		}
	} finally {
		reader.releaseLock();
	}
}
