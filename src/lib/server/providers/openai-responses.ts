import type {
	ChatRequest,
	CompletionResult,
	MessageContent,
	ProviderAdapter,
	ProviderMessage,
	RemoteModel,
	StreamEvent,
	ToolCall,
	Usage
} from './types';
import { ProviderHttpError } from './types';
import { sseLines } from './openai-compatible';

// OpenAI's own models, over the Responses API rather than /chat/completions.
//
// Chat completions still works against OpenAI, which is why this is a second
// adapter and not a replacement: OpenRouter, Ollama and vLLM speak the older
// protocol and keep the adapter beside this one. What chat completions cannot
// do is carry a reasoning model's thinking from one tool step to the next, and
// a coding leg is nothing but tool steps.

export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

export interface OpenAiResponsesOptions {
	baseUrl: string;
	apiKey?: string;
}

/**
 * What OpenAI does not say about its own models.
 *
 * `GET /v1/models` returns an id, an owner and a creation date. Nothing about
 * tools, vision, context or price, so a sync read the way the compat adapter
 * reads OpenRouter would import every model with `supportsTools: false` (which
 * the coding task refuses) and null prices (which the spend cap cannot see).
 * Hence this table, and hence a sync that imports only what is in it: a model
 * the table does not know is a model nothing here could price.
 *
 * Prices are USD per million tokens at list rate, taken from third-party
 * summaries of OpenAI's pricing page in September 2026 because the page itself
 * was not reachable when this was written. List rather than the promotional
 * Sol rate running to November, so the cap overcounts until then instead of
 * undercounting after. `costOf` has one rate per direction, so Sol's higher
 * tier above 272K input tokens is not modelled; compaction keeps a coding leg
 * well under it.
 *
 * Matched on the exact id or a dated snapshot of it (`gpt-5.6-sol-2026-08-01`).
 */
interface KnownModel {
	displayName: string;
	contextWindow: number;
	promptCostPerMTok: number;
	completionCostPerMTok: number;
	/** Cache reads bill at a tenth of input. Used to price the discount, see readResponsesUsage. */
	cachedPromptCostPerMTok: number;
	supportsVision: boolean;
	reasoning: boolean;
}

export const KNOWN_OPENAI_MODELS: Record<string, KnownModel> = {
	'gpt-5.6-sol': {
		displayName: 'GPT-5.6 Sol',
		contextWindow: 1_050_000,
		promptCostPerMTok: 5,
		completionCostPerMTok: 30,
		cachedPromptCostPerMTok: 0.5,
		supportsVision: true,
		reasoning: true
	},
	'gpt-5.6-terra': {
		displayName: 'GPT-5.6 Terra',
		contextWindow: 1_050_000,
		promptCostPerMTok: 2,
		completionCostPerMTok: 12,
		cachedPromptCostPerMTok: 0.2,
		supportsVision: true,
		reasoning: true
	},
	'gpt-5.6-luna': {
		displayName: 'GPT-5.6 Luna',
		contextWindow: 1_050_000,
		promptCostPerMTok: 0.2,
		completionCostPerMTok: 1.2,
		cachedPromptCostPerMTok: 0.02,
		supportsVision: true,
		reasoning: true
	}
};

/** Exported for tests. */
export function knownModel(modelKey: string): KnownModel | undefined {
	if (KNOWN_OPENAI_MODELS[modelKey]) return KNOWN_OPENAI_MODELS[modelKey];
	const base = Object.keys(KNOWN_OPENAI_MODELS).find((k) =>
		new RegExp(`^${k.replace(/\./g, '\\.')}-\\d{4}-\\d{2}-\\d{2}$`).test(modelKey)
	);
	return base ? KNOWN_OPENAI_MODELS[base] : undefined;
}

export function createOpenAiResponsesAdapter(opts: OpenAiResponsesOptions): ProviderAdapter {
	const headers = (): Record<string, string> => ({
		'content-type': 'application/json',
		...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {})
	});

	async function post(req: ChatRequest, stream: boolean, signal?: AbortSignal) {
		const res = await fetch(`${opts.baseUrl}/responses`, {
			method: 'POST',
			headers: headers(),
			body: JSON.stringify(responsesBody(req, stream)),
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
			yield* parseResponsesStream(res.body, req.modelKey);
		},

		async complete(req, signal) {
			const res = await post(req, false, signal);
			return readResponse((await res.json()) as Record<string, unknown>, req.modelKey);
		},

		async listModels(signal) {
			const res = await fetch(`${opts.baseUrl}/models`, { headers: headers(), signal });
			if (!res.ok) throw new ProviderHttpError(res.status, `Model listing failed: ${res.status}`);
			const data = await res.json();
			const rows: unknown[] = Array.isArray(data.data) ? data.data : [];
			const out: RemoteModel[] = [];
			for (const raw of rows) {
				const id = String((raw as { id?: unknown }).id ?? '');
				const known = knownModel(id);
				if (!known) continue;
				out.push({
					key: id,
					displayName: knownDisplayName(id, known),
					contextWindow: known.contextWindow,
					supportsTools: true,
					supportsVision: known.supportsVision,
					supportsImageOutput: false,
					supportsReasoning: known.reasoning,
					promptCostPerMTok: known.promptCostPerMTok,
					completionCostPerMTok: known.completionCostPerMTok,
					// OpenAI caches a stable prefix on its own; there is no marker to send.
					cacheMode: 'auto'
				});
			}
			return out;
		}
	};
}

/** A dated snapshot keeps its date in the name, so it is not mistaken for the alias. */
function knownDisplayName(id: string, known: KnownModel): string {
	const date = /-(\d{4}-\d{2}-\d{2})$/.exec(id)?.[1];
	return date ? `${known.displayName} (${date})` : known.displayName;
}

/**
 * The request body for `POST /responses`. Exported for tests.
 *
 * `store: false` always. Stored responses would keep every prompt on OpenAI's
 * side, hidden chats included, and chaining on `previous_response_id` would
 * fight `buildContext`, which rebuilds and compacts the transcript every leg.
 * The cost of statelessness is that reasoning has to be carried by hand, which
 * is what `include` and `providerItems` are for.
 */
export function responsesBody(req: ChatRequest, stream: boolean): Record<string, unknown> {
	const reasoningModel = knownModel(req.modelKey)?.reasoning ?? false;
	return {
		model: req.modelKey,
		input: toInputItems(req.messages),
		...(req.tools?.length
			? {
					tools: req.tools.map((t) => ({
						type: 'function',
						name: t.name,
						description: t.description,
						parameters: t.parameters,
						// Strict mode requires every property listed in `required` and
						// `additionalProperties: false` throughout. Galaxy's tool schemas
						// have optional fields, and a schema strict mode rejects is a 400
						// on every call that offers the tool.
						strict: false
					}))
				}
			: {}),
		// Reasoning models reject a temperature other than the default.
		...(req.temperature !== undefined && !reasoningModel ? { temperature: req.temperature } : {}),
		...(req.maxTokens !== undefined ? { max_output_tokens: req.maxTokens } : {}),
		...(req.reasoning ? { reasoning: { effort: req.reasoning } } : {}),
		...(reasoningModel ? { include: ['reasoning.encrypted_content'] } : {}),
		store: false,
		stream
	};
}

/**
 * Galaxy's transcript as Responses input items. Exported for tests.
 *
 * System messages stay in place as `developer` messages rather than being
 * hoisted into `instructions`: buildContext puts the volatile state block after
 * the history precisely so the prefix in front of it caches, and hoisting would
 * reorder what it arranged.
 */
export function toInputItems(messages: ProviderMessage[]): unknown[] {
	const items: unknown[] = [];
	for (const m of messages) {
		if (m.role === 'tool') {
			items.push({
				type: 'function_call_output',
				call_id: m.tool_call_id ?? '',
				output: plainText(m.content)
			});
			continue;
		}
		if (m.role === 'assistant') {
			if (m.providerItems?.length) {
				items.push(...m.providerItems.map(replayItem).filter(Boolean));
				continue;
			}
			const text = plainText(m.content);
			if (text) items.push({ type: 'message', role: 'assistant', content: text });
			for (const call of m.tool_calls ?? []) {
				items.push({
					type: 'function_call',
					call_id: call.id,
					name: call.name,
					arguments: call.arguments
				});
			}
			continue;
		}
		items.push({
			type: 'message',
			role: m.role === 'system' ? 'developer' : 'user',
			content: typeof m.content === 'string' ? m.content : toInputParts(m.content)
		});
	}
	return items;
}

function toInputParts(content: Exclude<MessageContent, string>): unknown[] {
	return content.map((part) =>
		part.type === 'text'
			? { type: 'input_text', text: part.text }
			: { type: 'input_image', image_url: part.image_url.url }
	);
}

function plainText(content: MessageContent): string {
	if (typeof content === 'string') return content;
	return content
		.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
		.map((p) => p.text)
		.join('\n');
}

/**
 * One output item from an earlier call, as input to this one.
 *
 * Reasoning goes back exactly as it came, id and encrypted content together:
 * without `store` the id alone refers to nothing and the call is refused.
 * Messages and function calls are rebuilt without their ids for the same
 * reason, since there is no stored item for an id to point at.
 */
function replayItem(raw: unknown): unknown {
	const item = raw as Record<string, unknown>;
	if (item?.type === 'reasoning') {
		if (typeof item.encrypted_content !== 'string') return null;
		return {
			type: 'reasoning',
			id: item.id,
			summary: Array.isArray(item.summary) ? item.summary : [],
			encrypted_content: item.encrypted_content
		};
	}
	if (item?.type === 'function_call') {
		return {
			type: 'function_call',
			call_id: item.call_id,
			name: item.name,
			arguments: item.arguments
		};
	}
	if (item?.type === 'message') {
		const text = outputText([item]);
		return text ? { type: 'message', role: 'assistant', content: text } : null;
	}
	return null;
}

/**
 * Usage off a Responses payload, in the shape the compat adapter's readUsage
 * produces. Exported for tests.
 *
 * OpenAI reports what was cached but not what that saved, and `costOf` prices
 * every prompt token at the input rate less `cacheDiscountUsd`. So the discount
 * is worked out here from the known rates. Left out, a coding leg that re-sends
 * the same long prefix every step would be counted at ten times what it cost.
 */
export function readResponsesUsage(raw: Record<string, unknown>, modelKey: string): Usage {
	const num = (v: unknown): number | undefined =>
		typeof v === 'number' && Number.isFinite(v) ? v : undefined;
	const inDetails = (raw.input_tokens_details ?? {}) as Record<string, unknown>;
	const outDetails = (raw.output_tokens_details ?? {}) as Record<string, unknown>;
	const cached = num(inDetails.cached_tokens);
	const reasoning = num(outDetails.reasoning_tokens);
	const known = knownModel(modelKey);
	const discount =
		cached && known
			? (cached * (known.promptCostPerMTok - known.cachedPromptCostPerMTok)) / 1_000_000
			: undefined;
	return {
		promptTokens: num(raw.input_tokens) ?? 0,
		completionTokens: num(raw.output_tokens) ?? 0,
		...(cached !== undefined ? { cachedPromptTokens: cached } : {}),
		...(discount !== undefined ? { cacheDiscountUsd: discount } : {}),
		...(reasoning !== undefined ? { reasoningTokens: reasoning } : {})
	};
}

function outputText(output: unknown[]): string {
	let text = '';
	for (const raw of output) {
		const item = raw as Record<string, unknown>;
		if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
		for (const part of item.content as Record<string, unknown>[]) {
			if (part?.type === 'output_text' && typeof part.text === 'string') text += part.text;
		}
	}
	return text;
}

function functionCalls(output: unknown[]): ToolCall[] {
	return output
		.map((raw) => raw as Record<string, unknown>)
		.filter((item) => item?.type === 'function_call')
		.map((item, i) => ({
			id: typeof item.call_id === 'string' && item.call_id ? item.call_id : `call_${i}`,
			name: String(item.name ?? ''),
			arguments: typeof item.arguments === 'string' && item.arguments ? item.arguments : '{}'
		}));
}

/**
 * The chat-completions finish reason a response's status corresponds to, since
 * that is the vocabulary the loop and `reasonedOnly` were written against.
 * 'length' is the one that matters: a reasoning model that thought until its
 * cap comes back `incomplete` with reason `max_output_tokens`.
 */
function finishReasonOf(response: Record<string, unknown>, calls: number): string | null {
	const status = response.status;
	if (status === 'incomplete') {
		const reason = (response.incomplete_details as { reason?: unknown } | undefined)?.reason;
		return reason === 'max_output_tokens' ? 'length' : typeof reason === 'string' ? reason : 'length';
	}
	if (status === 'completed') return calls ? 'tool_calls' : 'stop';
	return typeof status === 'string' ? status : null;
}

/** A non-streamed response. Exported for tests. */
export function readResponse(data: Record<string, unknown>, modelKey: string): CompletionResult {
	const output = Array.isArray(data.output) ? (data.output as unknown[]) : [];
	const text = outputText(output);
	const reasoned = output.some((i) => (i as { type?: unknown })?.type === 'reasoning');
	return {
		text,
		finishReason: finishReasonOf(data, functionCalls(output).length),
		reasonedOnly: !text && reasoned,
		usage: data.usage ? readResponsesUsage(data.usage as Record<string, unknown>, modelKey) : null
	};
}

/**
 * An error the stream reported after the HTTP status had already said 200.
 * Mapped onto a status so `isRetryable` treats it the way it would the same
 * failure arriving as a response code.
 */
function streamError(err: Record<string, unknown> | undefined): ProviderHttpError {
	const code = String(err?.code ?? '');
	const message = String(err?.message ?? 'the response failed');
	const status = /rate_limit/.test(code) ? 429 : /server_error|overloaded/.test(code) ? 500 : 400;
	return new ProviderHttpError(status, `Provider ${code || 'error'}: ${message.slice(0, 500)}`);
}

/**
 * Parse a Responses SSE stream into StreamEvents. Exported for tests.
 *
 * Tool calls are read off `response.output_item.done`, where they arrive whole,
 * rather than assembled from argument deltas the way the compat parser has to.
 * The deltas still yield `progress`: a write_file payload streams for a minute
 * or more, and the idle watchdog in loop.ts would otherwise see silence.
 */
export async function* parseResponsesStream(
	stream: ReadableStream<Uint8Array>,
	modelKey: string
): AsyncGenerator<StreamEvent> {
	const output: unknown[] = [];
	let usage: Usage | null = null;
	let finishReason: string | null = null;

	for await (const line of sseLines(stream)) {
		// `event:` lines name the event the next data line carries, which the data
		// line repeats in its `type`; comments are keep-alives. Both are the
		// connection being alive.
		if (!line.startsWith('data:')) {
			yield { type: 'progress' };
			continue;
		}
		const data = line.slice(5).trim();
		if (data === '[DONE]') break;
		let ev: Record<string, unknown>;
		try {
			ev = JSON.parse(data);
		} catch {
			yield { type: 'progress' };
			continue;
		}

		switch (ev.type) {
			case 'response.output_text.delta':
				if (typeof ev.delta === 'string' && ev.delta) yield { type: 'text', delta: ev.delta };
				else yield { type: 'progress' };
				break;
			case 'response.reasoning_summary_text.delta':
				if (typeof ev.delta === 'string' && ev.delta) yield { type: 'reasoning', delta: ev.delta };
				else yield { type: 'progress' };
				break;
			case 'response.output_item.done':
				if (ev.item) output.push(ev.item);
				yield { type: 'progress' };
				break;
			case 'response.completed':
			case 'response.incomplete': {
				const response = (ev.response ?? {}) as Record<string, unknown>;
				if (response.usage) {
					usage = readResponsesUsage(response.usage as Record<string, unknown>, modelKey);
				}
				finishReason = finishReasonOf(response, functionCalls(output).length);
				break;
			}
			case 'response.failed':
				throw streamError(
					((ev.response ?? {}) as Record<string, unknown>).error as Record<string, unknown>
				);
			case 'error':
				throw streamError(ev);
			default:
				yield { type: 'progress' };
		}
	}

	const calls = functionCalls(output);
	if (calls.length) {
		// Only worth carrying when there is a next step to carry it into. A reply
		// with no calls ends the leg, and the transcript it ends is not reused.
		yield { type: 'provider_items', items: output };
		yield { type: 'tool_calls', calls };
	}
	if (usage) yield { type: 'usage', usage };
	yield { type: 'done', finishReason };
}
