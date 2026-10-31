export interface TextPart {
	type: 'text';
	text: string;
}
export interface ImagePart {
	type: 'image_url';
	image_url: { url: string };
}
export type MessageContent = string | (TextPart | ImagePart)[];

export interface ToolCall {
	id: string;
	name: string;
	/** Raw JSON string of arguments as produced by the model. */
	arguments: string;
}

/**
 * One block of a model's structured reasoning, as OpenRouter returns it in
 * `reasoning_details`: plain text, a summary, or an encrypted blob, any of them
 * with a signature. Opaque to us. The only thing done with one is to hand it
 * back, unmodified and in order, on the next request of the same tool chain.
 * Unknown fields are carried for the same reason.
 */
export interface ReasoningDetail {
	type: string;
	index?: number;
	id?: string | null;
	format?: string | null;
	text?: string;
	summary?: string;
	data?: string;
	signature?: string | null;
	[key: string]: unknown;
}

export interface ProviderMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: MessageContent;
	tool_call_id?: string;
	tool_calls?: ToolCall[];
	/**
	 * The reasoning that produced this assistant message's tool calls, and the
	 * model row that produced it.
	 *
	 * Anthropic's thinking with tools and Gemini's thought signatures both
	 * expect the reasoning back on the tool-call message when the chain
	 * continues; without it the model loses its train of thought between steps,
	 * and some endpoints refuse the request. The model id travels with the
	 * blocks because a signature is only good at the endpoint that issued it:
	 * failover strips anything tagged with another row (see `forModel` in
	 * loop.ts). Never persisted, never sent to the browser.
	 */
	reasoningDetails?: { modelId: string; items: ReasoningDetail[] };
}

export interface ToolDef {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

export interface Usage {
	promptTokens: number;
	completionTokens: number;
	/**
	 * Prompt tokens the provider served from its cache, when it says so.
	 *
	 * Reported as `prompt_tokens_details.cached_tokens`, which is the OpenAI
	 * field OpenRouter and most gateways mirror. Absent means "the provider did
	 * not say" — never "nothing was cached", which is why it is optional rather
	 * than defaulted to zero.
	 */
	cachedPromptTokens?: number;
	/**
	 * What caching saved on this call, in USD, when the gateway prices it for us
	 * (OpenRouter's `cache_discount`). Can be *negative* on the turn that writes
	 * the cache, because a write costs more than plain input; later reads turn it
	 * positive.
	 */
	cacheDiscountUsd?: number;
	/**
	 * Output tokens the model spent thinking rather than answering, when the
	 * provider breaks it out (`completion_tokens_details.reasoning_tokens`).
	 *
	 * The number that makes a slow run legible, and it was missing for the whole
	 * of three separate investigations. A groom run reported 13,851 completion
	 * tokens against a 1,596-character answer — about four hundred tokens of
	 * reply and thirteen thousand of chain-of-thought, at four and a half
	 * minutes. Completion tokens alone cannot tell that apart from a model that
	 * wrote a very long answer.
	 *
	 * Optional rather than defaulted to zero, for the same reason as the cache
	 * fields above: "the provider said nothing" and "nothing was reasoned" are
	 * different answers.
	 */
	reasoningTokens?: number;
	/**
	 * What the provider says the call cost, in USD, when it says (OpenRouter's
	 * `usage.cost`). The only honest price for an image model, which is billed
	 * per image or per megapixel rather than by the token rates on its row.
	 * Optional like the fields above: absent is "not said", not "free".
	 */
	costUsd?: number;
}

export type StreamEvent =
	| { type: 'text'; delta: string }
	/**
	 * Chain-of-thought from a reasoning model, which arrives on a separate
	 * channel from the answer and counts against the same token budget. Emitted
	 * so a caller can tell "spent everything thinking" apart from "said nothing"
	 * — silently dropping it made an empty answer look like a successful run.
	 */
	| { type: 'reasoning'; delta: string }
	/**
	 * The provider sent something real that produces no other event.
	 *
	 * This exists for the idle watchdog in loop.ts, which re-arms on every event
	 * yielded from a stream and so could only see text, reasoning and the final
	 * tool-call batch. Everything else a provider sends was silence to it: the
	 * argument fragments of a tool call, which arrive continuously and yield
	 * nothing until the stream ends, and the keep-alive comments a gateway sends
	 * precisely to say it is still working. A model writing a large file was
	 * therefore killed for going quiet while it was plainly not.
	 *
	 * Carries nothing. Consumers ignore it; the watchdog only needs to know that
	 * bytes arrived.
	 */
	| { type: 'progress' }
	/**
	 * The structured reasoning of this completion, assembled from its stream
	 * fragments, emitted once and before `tool_calls`. Only when there was some.
	 */
	| { type: 'reasoning_details'; details: ReasoningDetail[] }
	| { type: 'tool_calls'; calls: ToolCall[] }
	| { type: 'usage'; usage: Usage }
	| { type: 'done'; finishReason: string | null };

export type CacheMode = 'auto' | 'explicit' | 'none';

/**
 * How much of its output budget a model may spend thinking.
 *
 * `low` is the floor rather than an off switch, and deliberately so: models
 * with mandatory reasoning reject a request that tries to disable it outright,
 * so there is no value here that is safe everywhere *and* means none.
 */
export type ReasoningEffort = 'low' | 'medium' | 'high';

export interface ChatRequest {
	modelKey: string;
	messages: ProviderMessage[];
	tools?: ToolDef[];
	temperature?: number;
	maxTokens?: number;
	/** See models.cacheMode. Absent behaves as 'auto': send nothing. */
	cacheMode?: CacheMode;
	/**
	 * How hard the model should think, for the models that can be told.
	 *
	 * The lever this app spent three incidents not having. `maxTokens` does not
	 * govern reasoning — a run capped at 4,096 wrote 13,851 tokens and was not
	 * truncated — so every attempt to make a job faster by moving that number,
	 * or the timeout under it, was aimed at the wrong thing. Reasoning tokens
	 * are output tokens: they are the wall clock.
	 *
	 * Absent sends nothing, exactly as an unset `cacheMode` and `modalities` do.
	 * An endpoint that has never heard of the field is entitled to reject the
	 * whole request over it, so a caller asking for this is only honoured when
	 * the model is known to accept it — see `reasoningFor` in engine.ts.
	 */
	reasoning?: ReasoningEffort;
	/**
	 * What the model may reply *with*, as opposed to what it can be shown.
	 *
	 * Only sent when asked for, because an endpoint that has never heard of the
	 * field is entitled to reject the whole request over it — the same caution
	 * cacheMode's 'auto' exists for. `['image', 'text']` is what an
	 * image-generating model wants; leaving it unset is the text-only default
	 * every other call makes.
	 */
	modalities?: string[];
	/**
	 * Shape of a drawn image on the chat-completions path, as OpenRouter takes
	 * it: `aspect_ratio` and `image_size` (1K, 2K, 4K). Sent only when set, for
	 * the same reason as `modalities`.
	 */
	imageConfig?: { aspect_ratio?: string; image_size?: string };
	/**
	 * OpenRouter's provider routing, to hold the serving endpoint fixed while
	 * something else is compared. Sent as given and only when given; nothing in
	 * production sets it, only the evaluation runner.
	 */
	provider?: ProviderRouting;
}

/** The subset of OpenRouter's `provider` object a comparison needs. */
export interface ProviderRouting {
	order?: string[];
	only?: string[];
	allow_fallbacks?: boolean;
	require_parameters?: boolean;
}

/**
 * A request to OpenRouter's Image API, which takes what chat completions has no
 * field for: several reference images, a count, quality, a transparent
 * background, an output format, a seed. Every option is optional and sent only
 * when set, because providers clamp or refuse what they do not support.
 */
export interface ImageRequest {
	modelKey: string;
	prompt: string;
	/** Images to work from, as data or https URLs. */
	references?: string[];
	n?: number;
	resolution?: string;
	aspectRatio?: string;
	size?: string;
	quality?: 'auto' | 'low' | 'medium' | 'high';
	outputFormat?: 'png' | 'jpeg' | 'webp' | 'svg';
	background?: 'auto' | 'transparent' | 'opaque';
	outputCompression?: number;
	seed?: number;
}

export interface ImageResult {
	images: GeneratedImage[];
	usage: Usage | null;
}

/** An image a model produced, decoded from the data URL it arrived as. */
export interface GeneratedImage {
	mime: string;
	base64: string;
}

export interface RemoteModel {
	key: string;
	displayName: string;
	contextWindow: number | null;
	supportsTools: boolean;
	supportsVision: boolean;
	promptCostPerMTok: number | null;
	completionCostPerMTok: number | null;
	/** The model draws: it returns images as well as text. */
	supportsImageOutput: boolean;
	/** It returns images and never text: see `models.imageOnly`. */
	imageOnly: boolean;
	/** Served on OpenRouter's Image API: see `models.imageApi`. */
	imageApi: boolean;
	/**
	 * The model accepts being told how hard to think — it advertises `reasoning`
	 * among its supported parameters.
	 *
	 * A capability the provider reports, like `supportsTools`, so a re-sync
	 * corrects it. It gates whether the field may be *sent* at all; how much to
	 * think is the job's business and the admin's.
	 */
	supportsReasoning: boolean;
	/** Starting point for models.cacheMode; only ever applied on first import. */
	cacheMode: CacheMode;
}

export interface CompletionResult {
	text: string;
	usage: Usage | null;
	/**
	 * Why generation stopped. 'length' with empty `text` is the reasoning-model
	 * failure: the whole budget went on thinking and no answer was produced.
	 */
	finishReason?: string | null;
	/** True when the model emitted chain-of-thought but no answer text. */
	reasonedOnly?: boolean;
	/**
	 * Images the model drew, when the request asked for the image modality.
	 * Absent on every ordinary call — nothing else in the engine looks at it.
	 */
	images?: GeneratedImage[];
}

export interface ProviderAdapter {
	stream(req: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent>;
	complete(req: ChatRequest, signal?: AbortSignal): Promise<CompletionResult>;
	listModels(signal?: AbortSignal): Promise<RemoteModel[]>;
	/**
	 * The dedicated Image API, where the endpoint has one. Absent means drawing
	 * goes through `complete` with the image modality.
	 */
	generateImages?(req: ImageRequest, signal?: AbortSignal): Promise<ImageResult>;
}

export class ProviderHttpError extends Error {
	constructor(
		public status: number,
		message: string
	) {
		super(message);
		this.name = 'ProviderHttpError';
	}
}

/**
 * A model call that went quiet, or ran past the absolute ceiling.
 *
 * Deliberately not an AbortError: `isCancellation` treats those as the user
 * pressing stop and keeps the partial reply as if the run had finished
 * normally, which would silently truncate an answer that actually stalled.
 */
export class StreamTimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'StreamTimeoutError';
	}
}

/** Errors worth retrying / failing over on: network, timeouts, 429, 5xx. */
export function isRetryable(err: unknown): boolean {
	if (err instanceof ProviderHttpError) return err.status === 429 || err.status >= 500;
	if (err instanceof StreamTimeoutError) return true;
	if (err instanceof Error && err.name === 'AbortError') return true;
	if (err instanceof TypeError) return true; // fetch network failure
	return false;
}
