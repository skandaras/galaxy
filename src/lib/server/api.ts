import { error } from '@sveltejs/kit';
import type { SessionUser } from '$lib/server/auth';

export function requireUser(locals: App.Locals): SessionUser {
	if (!locals.user) error(401, 'Unauthorized');
	return locals.user;
}

export function requireAdmin(locals: App.Locals): SessionUser {
	const user = requireUser(locals);
	if (!user.isAdmin) error(403, 'Admin only');
	return user;
}

const HEARTBEAT_MS = 25_000;

export interface SseChannel {
	send: (data: unknown, eventName?: string) => void;
	/** End the stream from the server side (e.g. when a job finishes). */
	close: () => void;
}

/**
 * Build an SSE Response. `setup` receives the channel and returns a cleanup
 * callback invoked when the stream ends from either side.
 */
export function sseResponse(setup: (channel: SseChannel) => () => void): Response {
	let cleanup: (() => void) | null = null;
	let heartbeat: ReturnType<typeof setInterval> | null = null;
	let closed = false;

	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();
			const teardown = () => {
				if (closed) return;
				closed = true;
				if (heartbeat) clearInterval(heartbeat);
				cleanup?.();
			};
			const send = (data: unknown, eventName?: string) => {
				if (closed) return;
				try {
					const prefix = eventName ? `event: ${eventName}\n` : '';
					controller.enqueue(encoder.encode(`${prefix}data: ${JSON.stringify(data)}\n\n`));
				} catch {
					teardown();
				}
			};
			const close = () => {
				teardown();
				try {
					controller.close();
				} catch {
					/* already closed */
				}
			};
			heartbeat = setInterval(() => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(`: ping\n\n`));
				} catch {
					teardown();
				}
			}, HEARTBEAT_MS);
			cleanup = setup({ send, close });
		},
		cancel() {
			if (heartbeat) clearInterval(heartbeat);
			if (!closed) {
				closed = true;
				cleanup?.();
			}
		}
	});

	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache',
			connection: 'keep-alive'
		}
	});
}
