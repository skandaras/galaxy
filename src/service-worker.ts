/// <reference types="@sveltejs/kit" />
import { build, files, version } from '$service-worker';

// Cache-first for immutable build assets; the network for everything else
// (pages and /api stay live — jobs, SSE and auth must never be cached).
const CACHE = `galaxy-${version}`;
const ASSETS = [...build, ...files];

self.addEventListener('install', (event) => {
	const e = event as ExtendableEvent;
	e.waitUntil(
		caches.open(CACHE).then(async (cache) => {
			await cache.addAll(ASSETS);
			// Take over as soon as we're installed rather than waiting for every
			// tab to close. Without this a worker with a new capability — the push
			// handler, say — sits in "waiting" while the old one stays active, so a
			// device can subscribe successfully and then silently drop every
			// notification because the running worker has no listener for them.
			await (self as unknown as ServiceWorkerGlobalScope).skipWaiting();
		})
	);
});

self.addEventListener('activate', (event) => {
	const e = event as ExtendableEvent;
	e.waitUntil(
		(async () => {
			for (const key of await caches.keys()) {
				if (key !== CACHE) await caches.delete(key);
			}
			// Claim pages loaded before this worker existed, so the tab that just
			// updated is controlled without needing a reload.
			await (self as unknown as ServiceWorkerGlobalScope).clients.claim();
		})()
	);
});

/**
 * Web Push. Only urgent notifications are ever sent (see server/push.ts), so
 * anything arriving here is worth showing — today that means an agent parked on
 * a question, which gives up after ten minutes if nobody answers.
 */
self.addEventListener('push', (event) => {
	const e = event as PushEvent;
	if (!e.data) return;
	let payload: { id?: string; title?: string; body?: string; link?: string };
	try {
		payload = e.data.json();
	} catch {
		// Never show a raw undecodable payload to the user.
		return;
	}
	e.waitUntil(
		(self as unknown as ServiceWorkerGlobalScope).registration.showNotification(
			payload.title || 'Galaxy',
			{
				body: payload.body ?? '',
				// PNG, not the SVG: Android renders neither the notification icon nor
				// the badge from a vector.
				icon: '/icon-192.png',
				badge: '/icon-192.png',
				// Collapses repeats of the same question rather than stacking them.
				tag: payload.id ?? 'galaxy',
				data: { link: payload.link || '/chat' },
				requireInteraction: true
			}
		)
	);
});

self.addEventListener('notificationclick', (event) => {
	const e = event as NotificationEvent;
	e.notification.close();
	const link = (e.notification.data as { link?: string } | null)?.link ?? '/chat';
	e.waitUntil(
		(async () => {
			const scope = self as unknown as ServiceWorkerGlobalScope;
			const clients = await scope.clients.matchAll({
				type: 'window',
				includeUncontrolled: true
			});
			// Reuse a window that is already open rather than piling up tabs; the
			// installed PWA usually has exactly one.
			for (const client of clients) {
				if ('focus' in client) {
					await client.focus();
					if ('navigate' in client) await client.navigate(link);
					return;
				}
			}
			await scope.clients.openWindow(link);
		})()
	);
});

self.addEventListener('fetch', (event) => {
	const e = event as FetchEvent;
	if (e.request.method !== 'GET') return;
	const url = new URL(e.request.url);
	if (!ASSETS.includes(url.pathname)) return;
	e.respondWith(
		caches.open(CACHE).then(async (cache) => {
			const cached = await cache.match(url.pathname);
			return cached ?? fetch(e.request);
		})
	);
});
