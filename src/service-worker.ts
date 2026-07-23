/// <reference types="@sveltejs/kit" />
import { build, files, version } from '$service-worker';

// Cache-first for immutable build assets; the network for everything else
// (pages and /api stay live — jobs, SSE and auth must never be cached).
const CACHE = `galaxy-${version}`;
const ASSETS = [...build, ...files];

self.addEventListener('install', (event) => {
	const e = event as ExtendableEvent;
	e.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener('activate', (event) => {
	const e = event as ExtendableEvent;
	e.waitUntil(
		caches.keys().then(async (keys) => {
			for (const key of keys) if (key !== CACHE) await caches.delete(key);
		})
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
