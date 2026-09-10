/**
 * How many rows a Library search returns.
 *
 * Shared rather than declared twice: the page has to say when it is showing a
 * capped result, and a copy of the number in the page is a copy that goes stale
 * the first time the server's changes — which is how the alerts panel ended up
 * hard-coding the height of a navigation bar.
 */
export const SEARCH_LIMIT = 20;

/** Long enough that a phone keyboard stops firing a request per keystroke. */
export const SEARCH_DEBOUNCE_MS = 200;
