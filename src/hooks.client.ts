import type { HandleClientError } from '@sveltejs/kit';
import { reportClientError } from '$lib/client-report';

/**
 * The client had no error handling at all: no handleError, no window.onerror,
 * no unhandledrejection, no <svelte:boundary>. Svelte's invoke_error_boundary
 * walks the effect tree looking for a boundary, finds none, and rethrows into a
 * microtask — which drops every effect still queued in that batch. The page
 * keeps its last painted frame, scrolls, takes focus and accepts typed
 * characters, and answers no taps at all.
 *
 * The fault was reporting itself faithfully the whole time, into a console that
 * an installed phone app does not have. This is the other end of it.
 */
addEventListener('error', (e) => reportClientError(e.error ?? e.message));
addEventListener('unhandledrejection', (e) => reportClientError(e.reason));

export const handleError: HandleClientError = ({ error, message }) => {
	reportClientError(error);
	return { message };
};
