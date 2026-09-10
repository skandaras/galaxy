import { describe, expect, it } from 'vitest';
import { tabFromUrl, tabUrl } from './url-tab';

const TABS = ['Theme', 'Boards', 'Notifications'] as const;
const params = (q: string) => new URLSearchParams(q);

describe('tabFromUrl', () => {
	it('opens on the first tab when the URL says nothing', () => {
		expect(tabFromUrl(params(''), TABS)).toBe('Theme');
	});

	it('finds the tab the URL names', () => {
		expect(tabFromUrl(params('tab=boards'), TABS)).toBe('Boards');
	});

	it('does not care how it was capitalised', () => {
		// Links get lowercased by the things that carry them, and typed by hand.
		expect(tabFromUrl(params('tab=NOTIFICATIONS'), TABS)).toBe('Notifications');
	});

	it('falls back rather than showing nothing', () => {
		// A link that has outlived the pane it named should still open the page.
		expect(tabFromUrl(params('tab=telescope'), TABS)).toBe('Theme');
		expect(tabFromUrl(params('tab='), TABS)).toBe('Theme');
	});
});

describe('tabUrl', () => {
	it('leaves the default tab at the page’s own address', () => {
		// One URL for the default view, not two that render identically.
		expect(tabUrl('/settings', 'Theme', TABS)).toBe('/settings');
	});

	it('names any other tab', () => {
		expect(tabUrl('/settings', 'Boards', TABS)).toBe('/settings?tab=boards');
	});

	it('round-trips every tab it can produce', () => {
		for (const tab of TABS) {
			const url = new URL(tabUrl('/settings', tab, TABS), 'http://x');
			expect(tabFromUrl(url.searchParams, TABS)).toBe(tab);
		}
	});

	it('escapes a tab name that would not survive a query string', () => {
		const odd = ['First', 'A & B'] as const;
		expect(tabUrl('/x', 'A & B', odd)).toBe('/x?tab=a%20%26%20b');
		const url = new URL(tabUrl('/x', 'A & B', odd), 'http://x');
		expect(tabFromUrl(url.searchParams, odd)).toBe('A & B');
	});
});
