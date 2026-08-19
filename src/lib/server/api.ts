import { error } from '@sveltejs/kit';
import type { SessionUser } from '$lib/server/auth';
import {
	ALIGNMENT_ENABLED_KEY,
	DEFAULT_ALIGNMENT,
	getSetting,
	type AlignmentSettings
} from '$lib/server/settings';

export function requireUser(locals: App.Locals): SessionUser {
	if (!locals.user) error(401, 'Unauthorized');
	return locals.user;
}

export function requireAdmin(locals: App.Locals): SessionUser {
	const user = requireUser(locals);
	if (!user.isAdmin) error(403, 'Admin only');
	return user;
}

/**
 * Coding mode clones and pushes with one shared GitHub token, so it hands the
 * caller write access to every repository that token can reach. That is fine
 * for the token's owner and emphatically not fine by default for everyone else,
 * so it is a per-user grant rather than something every account gets.
 */
export function requireCoder(locals: App.Locals): SessionUser {
	const user = requireUser(locals);
	if (!user.canCode) {
		error(403, 'Coding is not enabled for your account — an admin can grant it in Admin → Users');
	}
	return user;
}

/**
 * Alignment holds the most private data in the platform — someone's stated
 * beliefs and their reflection journal. It is off until a person turns it on for
 * themselves, and this refuses every route while it is off, so hiding the nav
 * link is presentation rather than the actual boundary.
 *
 * Deliberately not an admin grant like `canCode`: nobody else decides whether
 * you may keep a journal, and being an admin grants no access to anyone else's.
 */
export function requireAlignment(locals: App.Locals): SessionUser {
	const user = requireUser(locals);
	const platform = getSetting<AlignmentSettings>('alignment', DEFAULT_ALIGNMENT);
	if (!platform.enabled) error(403, 'Alignment is switched off for this instance');
	if (!getSetting<boolean>(ALIGNMENT_ENABLED_KEY, false, user.id)) {
		error(403, 'Alignment is off — turn it on in Settings → Alignment');
	}
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
