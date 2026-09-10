/**
 * Which sub-tab a page is showing, kept in the URL rather than in $state.
 *
 * Settings, Admin and Alignment each hold between four and twelve tabs with no
 * route behind any of them. That meant Back left the page rather than the tab
 * you were on, a tab could not be linked to or shared, and the phone's More
 * sheet had no way to offer "Settings → Notifications" as a destination — only
 * "Settings", which always opened on Theme.
 */

/** The tab named by `?tab=`, or the first one. */
export function tabFromUrl<T extends string>(params: URLSearchParams, tabs: readonly T[]): T {
	const asked = params.get('tab');
	if (!asked) return tabs[0];
	// Case-insensitive, so a hand-written ?tab=notifications finds the pane that
	// calls itself Notifications, and a link survives someone lowercasing it.
	const found = tabs.find((t) => t.toLowerCase() === asked.toLowerCase());
	// An unknown tab lands on the first rather than on nothing: a link that has
	// outlived the pane it named should still open the page.
	return found ?? tabs[0];
}

/**
 * Where a tab lives.
 *
 * The first one is the page's own address rather than `?tab=theme`, so the
 * canonical link stays clean and there is only one URL for the default view.
 */
export function tabUrl<T extends string>(pathname: string, tab: T, tabs: readonly T[]): string {
	return tab === tabs[0] ? pathname : `${pathname}?tab=${encodeURIComponent(tab.toLowerCase())}`;
}
