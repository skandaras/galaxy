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

export interface ProviderMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: MessageContent;
	tool_call_id?: string;
	tool_calls?: ToolCall[];
}

export interface ToolDef {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

export interface Usage {
	promptTokens: number;
	completionTokens: number;
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
	| { type: 'tool_calls'; calls: ToolCall[] }
	| { type: 'usage'; usage: Usage }
	| { type: 'done'; finishReason: string | null };

export interface ChatRequest {
	modelKey: string;
	messages: ProviderMessage[];
	tools?: ToolDef[];
	temperature?: number;
	maxTokens?: number;
}

export interface RemoteModel {
	key: string;
	displayName: string;
	contextWindow: number | null;
	supportsTools: boolean;
	supportsVision: boolean;
	promptCostPerMTok: number | null;
	completionCostPerMTok: number | null;
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
}

export interface ProviderAdapter {
	stream(req: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent>;
	complete(req: ChatRequest, signal?: AbortSignal): Promise<CompletionResult>;
	listModels(signal?: AbortSignal): Promise<RemoteModel[]>;
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
