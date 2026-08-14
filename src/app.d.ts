import type { SessionUser } from '$lib/server/auth';

declare global {
	namespace App {
		interface Locals {
			user: SessionUser | null;
		}
		/**
		 * `message` is SvelteKit's own field; the rest let a 409 name the run
		 * that is blocking a chat so the browser can offer to stop it.
		 */
		interface Error {
			message: string;
			jobId?: string;
			task?: string;
			ageMinutes?: number;
		}
	}
}

export {};
