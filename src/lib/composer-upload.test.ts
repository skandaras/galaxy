import { describe, expect, it, vi } from 'vitest';
import { uploadStaged, type AttachmentRef } from './composer-upload';

const file = (name: string) => new File(['x'], name, { type: 'text/plain' });
const ref = (id: string): AttachmentRef => ({ id, name: `${id}.txt`, mime: 'text/plain' });
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const refused = (message: string) => new Response(JSON.stringify({ message }), { status: 413 });

describe('uploadStaged', () => {
	it('keeps refs already uploaded and adds the new ones after them', async () => {
		const fetcher = vi.fn().mockResolvedValueOnce(ok(ref('b')));
		const result = await uploadStaged('/up', [file('b.txt')], [ref('a')], fetcher);
		expect(result.uploaded.map((r) => r.id)).toEqual(['a', 'b']);
		expect(result.failed).toEqual([]);
		expect(result.error).toBeNull();
	});

	it('leaves a refused file staged, with the server reason', async () => {
		// The retry this exists for: what went up stays up, what did not stays
		// in the composer, and nothing is uploaded twice.
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(ok(ref('a')))
			.mockResolvedValueOnce(refused('too large'));
		const big = file('big.pdf');
		const result = await uploadStaged('/up', [file('a.txt'), big], [], fetcher);
		expect(result.uploaded.map((r) => r.id)).toEqual(['a']);
		expect(result.failed).toEqual([big]);
		expect(result.error).toBe('big.pdf: too large');
	});

	it('treats a network failure as a failed upload, not a crash', async () => {
		const fetcher = vi.fn().mockRejectedValueOnce(new TypeError('offline'));
		const result = await uploadStaged('/up', [file('a.txt')], [], fetcher);
		expect(result.failed).toHaveLength(1);
		expect(result.error).toBe('a.txt: upload failed');
	});

	it('uploads nothing when nothing is staged', async () => {
		const fetcher = vi.fn();
		const result = await uploadStaged('/up', [], [ref('a')], fetcher);
		expect(fetcher).not.toHaveBeenCalled();
		expect(result.uploaded).toEqual([ref('a')]);
	});
});
