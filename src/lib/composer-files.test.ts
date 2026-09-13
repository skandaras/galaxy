import { describe, expect, it } from 'vitest';
import { carriesFiles, filesFrom, nameArrival } from './composer-files';

const AT = new Date(2026, 8, 13, 14, 32, 5);

function png(name: string, type = 'image/png'): File {
	return new File([Uint8Array.from([137, 80, 78, 71])], name, { type });
}

describe('filesFrom', () => {
	it('finds nothing in a paste that is only text', () => {
		expect(filesFrom({ files: [], types: ['text/plain'] })).toEqual([]);
	});

	it('finds nothing when there is no transfer at all', () => {
		expect(filesFrom(null)).toEqual([]);
	});

	it('returns a real array, not the live list the browser handed over', () => {
		const file = png('shot.png');
		const out = filesFrom({ files: [file], types: ['Files'] });
		expect(Array.isArray(out)).toBe(true);
		expect(out).toEqual([file]);
	});
});

describe('carriesFiles', () => {
	it('says yes before the drop, when files is still empty', () => {
		// The whole point: during dragover the browser exposes the types and
		// withholds the files, so this cannot be answered by counting them.
		expect(carriesFiles({ files: [], types: ['Files'] })).toBe(true);
	});

	it('says no to text dragged around inside the page', () => {
		expect(carriesFiles({ files: [], types: ['text/plain', 'text/html'] })).toBe(false);
	});

	it('says no when there is no transfer', () => {
		expect(carriesFiles(undefined)).toBe(false);
	});
});

describe('nameArrival', () => {
	it("renames Chrome's image.png, which every paste is called", () => {
		expect(nameArrival(png('image.png'), AT).name).toBe('pasted-20260913-143205.png');
	});

	it("renames Safari's empty name", () => {
		expect(nameArrival(png(''), AT).name).toBe('pasted-20260913-143205.png');
	});

	it('takes the extension from the type, not from the name it did not have', () => {
		expect(nameArrival(png('', 'image/jpeg'), AT).name).toBe('pasted-20260913-143205.jpg');
		expect(nameArrival(png('', 'image/webp'), AT).name).toBe('pasted-20260913-143205.webp');
	});

	it('falls back to .bin rather than guessing at an unknown type', () => {
		expect(nameArrival(png('', 'application/x-thing'), AT).name).toBe(
			'pasted-20260913-143205.bin'
		);
	});

	it('leaves a name somebody chose alone', () => {
		const dropped = png('Screenshot 2026-09-13 at 14.32.05.png');
		expect(nameArrival(dropped, AT)).toBe(dropped);
	});

	it('keeps the bytes and the type when it renames', async () => {
		const renamed = nameArrival(png('image.png'), AT);
		expect(renamed.type).toBe('image/png');
		expect(new Uint8Array(await renamed.arrayBuffer())).toEqual(
			Uint8Array.from([137, 80, 78, 71])
		);
	});
});
