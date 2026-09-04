import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The web manifest is what an install — and Bubblewrap, building the Android
 * package — reads to decide what this app is called and what it looks like.
 * Nothing else in the tree imports it, so a stale path or a size that lies
 * about the file behind it would otherwise only show up on a phone.
 */

const STATIC = 'static';
const manifest = JSON.parse(readFileSync(join(STATIC, 'manifest.webmanifest'), 'utf8'));

/** Width and height out of a PNG's IHDR, which is always the first chunk. */
const pngSize = (path: string) => {
	const buf = readFileSync(path);
	return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
};

const icons: { src: string; sizes: string; type: string; purpose: string }[] = manifest.icons;

describe('web manifest', () => {
	it('points every icon at a file that exists', () => {
		for (const icon of icons) {
			expect(existsSync(join(STATIC, icon.src)), icon.src).toBe(true);
		}
	});

	it('declares sizes the files actually are', () => {
		for (const icon of icons.filter((i) => i.type === 'image/png')) {
			const { width, height } = pngSize(join(STATIC, icon.src));
			expect(`${width}x${height}`, icon.src).toBe(icon.sizes);
		}
	});

	// Bubblewrap resizes the icon with Jimp, which cannot decode SVG. Without a
	// raster this size in the manifest there is no APK, and the failure happens
	// at package time with a stack trace rather than here.
	it('carries a raster icon big enough to build an APK from', () => {
		const big = icons.filter(
			(i) => i.type === 'image/png' && pngSize(join(STATIC, i.src)).width >= 512
		);
		expect(big.length).toBeGreaterThan(0);
	});

	it('carries a maskable icon, so the launcher does not crop the art', () => {
		expect(icons.some((i) => i.purpose === 'maskable' && i.type === 'image/png')).toBe(true);
	});

	// Without an explicit id the app's identity is derived from start_url, so
	// changing where it opens would install a second copy alongside the first
	// rather than updating it.
	it('pins its identity rather than deriving it from start_url', () => {
		expect(manifest.id).toBe('/');
	});

	it('starts inside its own scope', () => {
		expect(manifest.start_url.startsWith(manifest.scope)).toBe(true);
	});
});

describe('app.html', () => {
	const html = readFileSync(join('src', 'app.html'), 'utf8');

	// Safari ignores an SVG here and puts a snapshot of the page on the home
	// screen instead, which looks like a bug nobody can explain.
	it('gives iOS a PNG touch icon that exists', () => {
		const href = html.match(/rel="apple-touch-icon" href="([^"]+)"/)?.[1];
		expect(href).toMatch(/\.png$/);
		expect(existsSync(join(STATIC, href!))).toBe(true);
	});
});
