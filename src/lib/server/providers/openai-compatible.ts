import type {
	CacheMode,
	ChatRequest,
	GeneratedImage,
	ImageRequest,
	ImageResult,
	MessageContent,
	ProviderAdapter,
	ProviderMessage,
	ReasoningDetail,
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
	/**
	 * The provider row's kind. OpenRouter speaks this protocol and adds two
	 * things nothing else here can assume: a model listing that hides
	 * image-only models unless asked, and an Image API beside chat completions.
	 */
	kind?: string;
}

export function createOpenAiCompatAdapter(opts: OpenAiCompatOptions): ProviderAdapter {
	const headers = (): Record<string, string> => ({
		'content-type': 'application/json',
		...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
		...opts.extraHeaders
	});

	async function post(req: ChatRequest, stream: boolean, signal?: AbortSignal) {
		const res = await fetch(`${opts.baseUrl}/chat/completions`, {
			method: 'POST',
			headers: headers(),
			body: JSON.stringify(requestBody(req, stream)),
			signal
		});
		if (!res.ok) {
			const text = await res.text().catch(() => '');
			throw new ProviderHttpError(res.status, `Provider ${res.status}: ${text.slice(0, 500)}`);
		}
		return res;
	}

	/**
	 * The models OpenRouter's Image API serves. Best effort: if the list cannot
	 * be read, every model keeps chat completions, which is how drawing worked
	 * before the Image API was used at all.
	 */
	async function imageApiModels(signal?: AbortSignal): Promise<Set<string>> {
		try {
			const res = await fetch(`${opts.baseUrl}/images/models`, { headers: headers(), signal });
			if (!res.ok) return new Set();
			const data = (await res.json()) as { data?: unknown };
			const rows = Array.isArray(data.data) ? data.data : Array.isArray(data) ? data : [];
			return new Set(
				rows
					.map((r) => (r as { id?: unknown; slug?: unknown }).id ?? (r as { slug?: unknown }).slug)
					.filter((id): id is string => typeof id === 'string')
			);
		} catch {
			return new Set();
		}
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
			// Through the same reader the stream path uses. This used to parse
			// `usage` inline and keep two fields, so every non-streaming job in the
			// app — which is all of them but chat — silently dropped its cache
			// statistics, and would have dropped reasoning tokens the same way.
			// Two parsers for one payload is one too many.
			const text = choice?.message?.content ?? '';
			// Reasoning models put chain-of-thought on its own field and leave
			// content empty when the budget runs out mid-thought.
			const reasoning =
				choice?.message?.reasoning_content ?? choice?.message?.reasoning ?? '';
			const images = toGeneratedImages(choice?.message?.images);
			return {
				text,
				finishReason: choice?.finish_reason ?? null,
				reasonedOnly: !text && Boolean(reasoning),
				...(images.length ? { images } : {}),
				usage: data.usage ? readUsage(data.usage as Record<string, unknown>) : null
			};
		},

		async listModels(signal) {
			// OpenRouter lists text-output models only unless told otherwise, so
			// Flux, GPT Image and the rest never reached Admin → Models and the
			// `visual` task could only ever be pointed at a model that also talks.
			const query = opts.kind === 'openrouter' ? '?output_modalities=text,image' : '';
			const res = await fetch(`${opts.baseUrl}/models${query}`, { headers: headers(), signal });
			if (!res.ok) throw new ProviderHttpError(res.status, `Model listing failed: ${res.status}`);
			const data = await res.json();
			const rows: unknown[] = Array.isArray(data.data) ? data.data : [];
			const onImageApi = opts.kind === 'openrouter' ? await imageApiModels(signal) : new Set<string>();
			return rows.map((raw) => toRemoteModel(raw as Record<string, unknown>, onImageApi));
		},

		...(opts.kind === 'openrouter'
			? {
					async generateImages(req: ImageRequest, signal?: AbortSignal): Promise<ImageResult> {
						const res = await fetch(`${opts.baseUrl}/images`, {
							method: 'POST',
							headers: headers(),
							body: JSON.stringify(imageRequestBody(req)),
							signal
						});
						if (!res.ok) {
							// The provider's own words, because they say which option it
							// refused, and the model can drop it and try again.
							const text = await res.text().catch(() => '');
							throw new ProviderHttpError(res.status, `Provider ${res.status}: ${text.slice(0, 500)}`);
						}
						const data = (await res.json()) as Record<string, unknown>;
						return {
							images: imageApiImages(data.data),
							usage: data.usage ? readUsage(data.usage as Record<string, unknown>) : null
						};
					}
				}
			: {})
	};
}

/** The Image API body: only what was asked for. Exported for tests. */
export function imageRequestBody(req: ImageRequest): Record<string, unknown> {
	const set = <T>(key: string, value: T | undefined) => (value === undefined ? {} : { [key]: value });
	return {
		model: req.modelKey,
		prompt: req.prompt,
		...set('n', req.n),
		...set('resolution', req.resolution),
		...set('aspect_ratio', req.aspectRatio),
		...set('size', req.size),
		...set('quality', req.quality),
		...set('output_format', req.outputFormat),
		...set('background', req.background),
		...set('output_compression', req.outputCompression),
		...set('seed', req.seed),
		...(req.references?.length
			? { input_references: req.references.map((url) => ({ type: 'image_url', image_url: { url } })) }
			: {})
	};
}

/**
 * The images off an Image API response: `data[].b64_json`, with `media_type`
 * where the provider could name it and sniffed from the bytes where it could
 * not.
 */
function imageApiImages(raw: unknown): GeneratedImage[] {
	if (!Array.isArray(raw)) return [];
	const out: GeneratedImage[] = [];
	for (const entry of raw) {
		const b64 = (entry as { b64_json?: unknown })?.b64_json;
		if (typeof b64 !== 'string' || !b64) continue;
		const named = (entry as { media_type?: unknown }).media_type;
		out.push({ mime: typeof named === 'string' && named ? named : sniffImage(b64), base64: b64 });
	}
	return out;
}

/** The format a base64 image is in, from the first bytes of its encoding. */
export function sniffImage(base64: string): string {
	if (base64.startsWith('iVBOR')) return 'image/png';
	if (base64.startsWith('/9j/')) return 'image/jpeg';
	if (base64.startsWith('UklGR')) return 'image/webp';
	if (base64.startsWith('R0lGOD')) return 'image/gif';
	if (base64.startsWith('PHN2Zy') || base64.startsWith('PD94')) return 'image/svg+xml';
	return 'image/png';
}

/**
 * The JSON body of a chat-completions request, exactly as it is sent: cache
 * breakpoints marked and reasoning blocks attached. Exported so the evaluation
 * runner can show what a model is actually handed.
 */
export function requestBody(req: ChatRequest, stream: boolean): Record<string, unknown> {
	return {
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
				: {}),
			// Handed back exactly as the same model row returned it. An endpoint
			// that never emits the field never receives it, the same caution
			// `modalities` carries, and loop.ts drops it before a request goes to
			// any other row.
			...(m.reasoningDetails?.items.length ? { reasoning_details: m.reasoningDetails.items } : {})
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
		/**
		 * How hard to think, and only when asked.
		 *
		 * Three things this must not do, each of which breaks a real endpoint:
		 *
		 * **Never send it unsolicited.** The same caution `modalities` carries —
		 * an endpoint that has never heard of the field may reject the request.
		 * The caller only asks when the model advertised support.
		 *
		 * **Never send `reasoning_effort` beside this.** Reasoning models return
		 * 400 when both forms arrive, so there is exactly one form here.
		 *
		 * **Never send `exclude: true`.** It keeps the chain-of-thought out of the
		 * response, which is the only thing `reasonedOnly` below can be detected
		 * from — the retry that rescues a model which thought itself out of room
		 * would go blind to the case it exists for. It saves no time either: the
		 * model still reasons, it just does not tell us.
		 */
		...(req.reasoning ? { reasoning: { effort: req.reasoning } } : {}),
		...(req.modalities?.length ? { modalities: req.modalities } : {}),
		...(req.imageConfig && Object.keys(req.imageConfig).length ? { image_config: req.imageConfig } : {}),
		...(req.provider ? { provider: req.provider } : {}),
		stream,
		...(stream ? { stream_options: { include_usage: true } } : {})
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
 * Only plain, non-empty string content is marked, and never a tool result: its
 * structure is not something every gateway will accept rewritten into a
 * content-part array, and a marker is never worth risking the call itself
 * over. An assistant message holding tool calls is marked when its narration
 * is non-empty, which is what keeps the breakpoint moving down a tool chain;
 * only its `content` is rewritten, so the calls and any reasoning beside them
 * go out untouched.
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
	const outDetails = (raw.completion_tokens_details ?? {}) as Record<string, unknown>;
	const cached = num(details.cached_tokens);
	const discount = num(raw.cache_discount);
	// Reasoning tokens are output tokens — charged as such, and generated at the
	// same rate — so this is the wall clock of a slow call, broken out from the
	// answer it produced. Without it a run that wrote four hundred tokens of
	// reply after thirteen thousand of thinking is indistinguishable from one
	// that wrote a very long answer.
	const reasoning = num(outDetails.reasoning_tokens);
	// Zero is a real price (a free model, a cached image); a negative one is not.
	const cost = num(raw.cost);
	return {
		promptTokens: num(raw.prompt_tokens) ?? 0,
		completionTokens: num(raw.completion_tokens) ?? 0,
		...(cached !== undefined ? { cachedPromptTokens: cached } : {}),
		...(discount !== undefined ? { cacheDiscountUsd: discount } : {}),
		...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
		...(cost !== undefined && cost >= 0 ? { costUsd: cost } : {})
	};
}

/** Map one entry of GET /models to our registry shape (OpenRouter-style fields optional). */
function toRemoteModel(m: Record<string, unknown>, onImageApi: Set<string> = new Set()): RemoteModel {
	const pricing = (m.pricing ?? {}) as Record<string, unknown>;
	const architecture = (m.architecture ?? {}) as Record<string, unknown>;
	const supported = (m.supported_parameters ?? []) as unknown[];
	const modalities = (architecture.input_modalities ?? []) as unknown[];
	const outputModalities = (architecture.output_modalities ?? []) as unknown[];
	const perTok = (v: unknown): number | null => {
		const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
		return Number.isFinite(n) ? n * 1_000_000 : null;
	};
	return {
		key: String(m.id),
		displayName: typeof m.name === 'string' && m.name ? m.name : String(m.id),
		contextWindow: typeof m.context_length === 'number' ? m.context_length : null,
		supportsTools: supported.includes('tools'),
		// Whether this model can be *told* how hard to think. Read the same way
		// `supportsTools` is, from the provider's own listing, because the cost of
		// guessing wrong is a 400 on every call to it.
		supportsReasoning: supported.includes('reasoning') || supported.includes('reasoning_effort'),
		supportsVision: modalities.includes('image'),
		promptCostPerMTok: perTok(pricing.prompt),
		completionCostPerMTok: perTok(pricing.completion),
		// The mirror of supportsVision above: what the model can be shown versus
		// what it can hand back.
		supportsImageOutput: outputModalities.includes('image'),
		// Only on positive evidence: a listing with no modalities at all says
		// nothing, and treating that as image-only would hide a text model.
		imageOnly: outputModalities.includes('image') && !outputModalities.includes('text'),
		imageApi: onImageApi.has(String(m.id)),
		cacheMode: defaultCacheMode(String(m.id))
	};
}

/**
 * Images off a chat completion, which arrive as data URLs on
 * `message.images[].image_url.url` — the shape OpenRouter returns for a model
 * asked for the image modality.
 *
 * Anything that is not a decodable data URL is dropped rather than thrown over:
 * a provider returning one broken entry among several should still deliver the
 * ones that worked.
 */
function toGeneratedImages(raw: unknown): GeneratedImage[] {
	if (!Array.isArray(raw)) return [];
	const out: GeneratedImage[] = [];
	for (const entry of raw) {
		const url = (entry as { image_url?: { url?: unknown } })?.image_url?.url;
		if (typeof url !== 'string') continue;
		const match = /^data:([^;,]+);base64,(.+)$/s.exec(url);
		if (!match) continue;
		out.push({ mime: match[1], base64: match[2] });
	}
	return out;
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
	const details: ReasoningDetail[] = [];
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
		const spoke = typeof reasoning === 'string' && reasoning.length > 0;
		if (spoke) {
			yield { type: 'reasoning', delta: reasoning };
		}
		// An encrypted block arrives with no readable reasoning beside it, so a
		// chunk carrying only this would otherwise be silence to the idle
		// watchdog, which re-arms on events and nothing else.
		if (accumulateReasoningDetails(details, delta.reasoning_details) && !spoke && !delta.content) {
			yield { type: 'progress' };
		}
		const toolCalls = delta.tool_calls as
			| { index?: number; id?: string; function?: { name?: string; arguments?: unknown } }[]
			| undefined;
		if (toolCalls) {
			for (const tc of toolCalls) {
				const idx = tc.index ?? 0;
				const entry = pendingCalls.get(idx) ?? { id: '', name: '', args: '' };
				if (tc.id) entry.id = tc.id;
				if (tc.function?.name) entry.name += tc.function.name;
				// Some servers send the arguments already parsed. Concatenated, an
				// object became "[object Object]", which no tool can read.
				const args = tc.function?.arguments;
				if (typeof args === 'string') entry.args += args;
				else if (args && typeof args === 'object') entry.args += JSON.stringify(args);
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

	if (details.length) yield { type: 'reasoning_details', details };
	if ((sawToolCallFinish || pendingCalls.size) && pendingCalls.size) {
		const calls: ToolCall[] = [...pendingCalls.entries()]
			.sort(([a], [b]) => a - b)
			.map(([i, c]) => ({ id: c.id || `call_${i}`, name: c.name, arguments: c.args || '{}' }));
		yield { type: 'tool_calls', calls };
	}
	if (usage) yield { type: 'usage', usage };
	yield { type: 'done', finishReason };
}

/** Fields whose fragments are pieces of one string; every other field is whole. */
const CONCATENATED = new Set(['text', 'summary', 'data']);

/**
 * Fold one chunk's `reasoning_details` fragments into the blocks so far.
 *
 * OpenRouter streams each block in pieces: text across several chunks, the
 * signature in a later one on its own, an encrypted blob split anywhere. A
 * fragment with an `index` belongs to the block of that index. One without
 * continues the last block if that is of the same type, also unindexed, and not
 * carrying a different id, and starts a new one otherwise. Pieces of `text`, `summary` and `data` are
 * concatenated; any other field takes its latest non-empty value, which is how
 * a signature that arrives after the text it signs lands on that block.
 * Unknown fields are kept, since the blocks go back verbatim.
 *
 * Returns whether the chunk carried anything. Exported for tests.
 */
export function accumulateReasoningDetails(acc: ReasoningDetail[], fragments: unknown): boolean {
	if (!Array.isArray(fragments) || !fragments.length) return false;
	let took = false;
	for (const raw of fragments) {
		if (!raw || typeof raw !== 'object') continue;
		const frag = raw as Record<string, unknown>;
		const type = typeof frag.type === 'string' ? frag.type : '';
		const index = typeof frag.index === 'number' ? frag.index : undefined;
		const id = typeof frag.id === 'string' && frag.id ? frag.id : undefined;
		const last = acc.at(-1);
		// Two blocks of one type in a row are still two blocks when their ids
		// differ: merged, the ciphertext of both would go back under one id.
		const continues =
			last &&
			last.index === undefined &&
			(!type || last.type === type) &&
			!(id && last.id && id !== last.id);
		const into = index !== undefined ? acc.find((d) => d.index === index) : continues ? last : undefined;
		const target: ReasoningDetail = into ?? { type };
		if (!into) acc.push(target);
		for (const [key, value] of Object.entries(frag)) {
			if (key === 'type' && target.type) continue;
			if (CONCATENATED.has(key) && typeof value === 'string') {
				target[key] = `${(target[key] as string | undefined) ?? ''}${value}`;
			} else if (value !== undefined && value !== null && value !== '') {
				target[key] = value;
			}
		}
		took = true;
	}
	// In index order where every block has one, which is the order they were
	// produced in; an unindexed stream is already in arrival order.
	if (acc.every((d) => d.index !== undefined)) acc.sort((a, b) => a.index! - b.index!);
	return took;
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
