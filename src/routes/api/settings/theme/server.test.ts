import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, runMigrations } from '$lib/server/db';
import { settings as settingsTable } from '$lib/server/db/schema';
import { getSetting } from '$lib/server/settings';
import { PRESETS, type Theme } from '$lib/theme';
import { PUT } from './+server';

/** Saving into the theme you are on, and naming a new one without clobbering another. */

beforeAll(() => {
	runMigrations();
});

beforeEach(() => {
	db.delete(settingsTable).run();
});

const locals = { user: { id: 'u1', isAdmin: false } };
const put = async (body: unknown) =>
	PUT({
		locals,
		request: new Request('http://x/api/settings/theme', { method: 'PUT', body: JSON.stringify(body) })
	} as never);
const status = (p: Promise<unknown>) =>
	p.then(
		() => 200,
		(e: { status?: number }) => e.status
	);
const custom = () => getSetting<Record<string, Theme>>('themePresets', {}, 'u1');
const active = () => getSetting<Theme | null>('theme', null, 'u1');

const dusk = { ...PRESETS.Galaxy, accent: '#ff9900' };

describe('PUT /api/settings/theme', () => {
	it('saveTo updates the saved theme and the active one together', async () => {
		await put({ theme: dusk, saveAs: 'Dusk' });
		const edited = { ...dusk, accent: '#00ccff' };
		await put({ theme: edited, saveTo: 'Dusk' });
		expect(custom().Dusk.accent).toBe('#00ccff');
		expect(active()?.accent).toBe('#00ccff');
	});

	it('saveTo a theme that does not exist is refused', async () => {
		expect(await status(put({ theme: dusk, saveTo: 'Nope' }))).toBe(404);
		expect(custom()).toEqual({});
	});

	it('saveAs refuses a name already in use, built-in or yours, and leaves everything as it was', async () => {
		await put({ theme: dusk, saveAs: 'Dusk' });
		const other = { ...dusk, accent: '#123456' };
		expect(await status(put({ theme: other, saveAs: 'dusk' }))).toBe(409);
		expect(await status(put({ theme: other, saveAs: 'Galaxy' }))).toBe(409);
		expect(custom().Dusk.accent).toBe('#ff9900');
		expect(active()?.accent).toBe('#ff9900');
	});

	it('a plain save sets the active theme and touches no saved one', async () => {
		await put({ theme: dusk, saveAs: 'Dusk' });
		await put({ theme: PRESETS.Paper });
		expect(custom().Dusk.accent).toBe('#ff9900');
		expect(active()?.bg).toBe(PRESETS.Paper.bg);
	});
});
