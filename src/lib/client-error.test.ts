import { describe, expect, it } from 'vitest';
import {
	createReportLimiter,
	describeClientError,
	REPORT_MAX,
	REPORT_WINDOW_MS
} from './client-error';

describe('describeClientError', () => {
	it('keeps the name and message together, which is what names the event', () => {
		const r = describeClientError(new TypeError('x is not a function'), { pathname: '/chat' }, 'v1');
		expect(r.name).toBe('TypeError: x is not a function');
		expect(r.version).toBe('v1');
	});

	it('survives something thrown that is not an Error', () => {
		expect(describeClientError('nope', { pathname: '/chat' }, 'v1').name).toBe('nope');
		expect(describeClientError(undefined, { pathname: '/chat' }, 'v1').name).toBe('undefined');
	});

	it('never carries the query string', () => {
		// The one rule that matters here: a hidden chat is addressed as
		// /chat?chat=<id> and that id must not reach the events table.
		const r = describeClientError(new Error('boom'), { pathname: '/chat' }, 'v1');
		expect(r.pathname).toBe('/chat');
		expect(JSON.stringify(r)).not.toContain('?');
	});

	it('truncates a stack rather than writing a novel to a row', () => {
		const err = new Error('boom');
		err.stack = 'at x\n'.repeat(5000);
		expect(describeClientError(err, { pathname: '/' }, 'v1').stack.length).toBeLessThan(4100);
	});
});

describe('createReportLimiter', () => {
	it('lets the first few through and then stops', () => {
		const limit = createReportLimiter();
		for (let i = 0; i < REPORT_MAX; i++) expect(limit.allow('boom', 1000)).toBe(true);
		expect(limit.allow('boom', 1000)).toBe(false);
	});

	it('still reports a different failure while one is being suppressed', () => {
		const limit = createReportLimiter();
		for (let i = 0; i < REPORT_MAX; i++) limit.allow('boom', 1000);
		expect(limit.allow('boom', 1000)).toBe(false);
		expect(limit.allow('other', 1000)).toBe(true);
	});

	it('opens again once the window has passed', () => {
		const limit = createReportLimiter();
		for (let i = 0; i < REPORT_MAX; i++) limit.allow('boom', 1000);
		expect(limit.allow('boom', 1000)).toBe(false);
		expect(limit.allow('boom', 1000 + REPORT_WINDOW_MS + 1)).toBe(true);
	});
});
