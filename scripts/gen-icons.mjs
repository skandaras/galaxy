/**
 * Rasterise the app icons.
 *
 *   node scripts/gen-icons.mjs
 *
 * The SVGs are the source of truth; these PNGs exist because three things
 * refuse to read an SVG:
 *
 *   - Bubblewrap resizes the manifest icon with Jimp, which has no SVG decoder
 *     at all, so an SVG-only manifest cannot be turned into an APK.
 *   - Safari ignores a non-PNG apple-touch-icon and puts a screenshot of the
 *     page on the home screen instead.
 *   - Android's adaptive launcher icon is only dependable from a raster.
 *
 * Chromium does the rendering because it is already here — Playwright is a
 * devDependency and CI installs chromium for the browser smoke. Adding an SVG
 * rasteriser as a dependency to produce four files that change once a year is
 * not a trade worth making.
 *
 * The output is committed, so this only needs running when an SVG changes.
 * The Docker build must never need a browser.
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const STATIC = 'static';

const TARGETS = [
	{ from: 'icon.svg', to: 'icon-192.png', size: 192 },
	{ from: 'icon.svg', to: 'icon-512.png', size: 512 },
	{ from: 'icon-maskable.svg', to: 'icon-maskable-512.png', size: 512 },
	// 180 is what current iPhones ask for; iOS downscales for everything else.
	{ from: 'icon.svg', to: 'apple-touch-icon-180.png', size: 180 }
];

// Same escape hatch, and the same variable, as scripts/smoke-ui.mjs: a machine
// that already has a browser Playwright did not put there, whose build number
// will not match the one this version expects. CI installs its own.
const browser = await chromium.launch({
	executablePath: process.env.GALAXY_CHROMIUM_PATH || undefined
});
try {
	for (const { from, to, size } of TARGETS) {
		const svg = readFileSync(join(STATIC, from), 'utf8');
		const page = await browser.newPage({ viewport: { width: size, height: size } });
		// Inline rather than navigating to the file: the SVG then scales to the
		// viewport instead of being letterboxed inside a document's default page
		// margin, and the screenshot needs no clip rectangle to be exact.
		await page.setContent(
			`<style>html,body{margin:0;padding:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`
		);
		writeFileSync(join(STATIC, to), await page.screenshot({ type: 'png' }));
		await page.close();
		console.log(`${from} -> ${to} (${size}x${size})`);
	}
} finally {
	await browser.close();
}
