/**
 * Uploading what is staged in a composer, shared by Chat and Code.
 *
 * Both pages ran this loop inline in their own `send()`. It is the part of a
 * send that has to survive a failure: files that went up are kept as refs, so a
 * retry after a refused message reuses them instead of uploading (and
 * orphaning) them again; files that did not stay staged with the reason.
 */

export interface AttachmentRef {
	id: string;
	name: string;
	mime: string;
	kind?: 'image' | 'document';
	textChars?: number;
}

export interface UploadResult {
	uploaded: AttachmentRef[];
	/** Still staged, because their upload failed. */
	failed: File[];
	/** One line per failure, for the page's banner; null when nothing failed. */
	error: string | null;
}

export async function uploadStaged(
	url: string,
	files: File[],
	already: AttachmentRef[],
	fetcher: typeof fetch = fetch
): Promise<UploadResult> {
	const uploaded = [...already];
	const failed: File[] = [];
	let error: string | null = null;
	for (const file of files) {
		const form = new FormData();
		form.append('file', file);
		const res = await fetcher(url, { method: 'POST', body: form }).catch(() => null);
		if (res?.ok) {
			uploaded.push(await res.json());
		} else {
			const err = res ? await res.json().catch(() => ({ message: res.statusText })) : null;
			error = `${file.name}: ${err?.message ?? 'upload failed'}`;
			failed.push(file);
		}
	}
	return { uploaded, failed, error };
}
