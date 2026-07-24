import { describe, it, expect } from 'vitest';
import { parseDuckDuckGoHtml } from './web-search';

describe('parseDuckDuckGoHtml', () => {
	const sample = `
		<div class="result">
			<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone&rut=abc">First <b>Result</b></a>
			<a class="result__snippet" href="x">A snippet about &amp; things.</a>
		</div>
		<div class="result">
			<a class="result__a" href="https://direct.example.org/two">Second Result</a>
			<a class="result__snippet" href="y">Second snippet.</a>
		</div>`;

	it('extracts titles, unwrapped urls and snippets', () => {
		const results = parseDuckDuckGoHtml(sample, 10);
		expect(results).toHaveLength(2);
		expect(results[0]).toEqual({
			title: 'First Result',
			url: 'https://example.com/one',
			snippet: 'A snippet about & things.'
		});
		expect(results[1].url).toBe('https://direct.example.org/two');
		expect(results[1].title).toBe('Second Result');
	});

	it('respects the max results cap', () => {
		expect(parseDuckDuckGoHtml(sample, 1)).toHaveLength(1);
	});

	it('returns nothing for an empty page', () => {
		expect(parseDuckDuckGoHtml('<html></html>', 10)).toEqual([]);
	});
});
