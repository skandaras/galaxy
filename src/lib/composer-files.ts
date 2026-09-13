/**
 * Files that arrive by paste or drop rather than through the file picker.
 *
 * Out here rather than in the two composers for the usual two reasons: chat and
 * code would otherwise hold a second identical copy of it, and tests run in
 * node with no DOM, so anything worth asserting has to leave the `.svelte` file
 * to be asserted at all.
 */

/**
 * What `ClipboardEvent.clipboardData` and `DragEvent.dataTransfer` have in
 * common. Declared structurally so the tests can hand these functions a plain
 * object instead of standing up a DataTransfer.
 */
export interface FileTransfer {
	files: ArrayLike<File>;
	types: readonly string[];
}

export function filesFrom(dt: FileTransfer | null | undefined): File[] {
	return dt ? Array.from(dt.files) : [];
}

/**
 * Whether a drag is carrying files at all.
 *
 * Read off `types` and not `files`, which stays empty until the drop itself —
 * a dragover asking `files.length` is asking a question the browser does not
 * answer until it is too late to highlight anything. It also keeps a selection
 * of text dragged around inside the page from lighting up the composer.
 */
export function carriesFiles(dt: FileTransfer | null | undefined): boolean {
	return dt ? Array.from(dt.types ?? []).includes('Files') : false;
}

/** Names a browser invents for a file it took off the clipboard. */
const GENERIC_STEMS = new Set(['', 'image', 'upload', 'blob']);

const MIME_EXTENSIONS: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/gif': 'gif',
	'image/webp': 'webp',
	'image/avif': 'avif',
	'image/svg+xml': 'svg',
	'image/bmp': 'bmp',
	'image/tiff': 'tiff',
	'application/pdf': 'pdf'
};

/**
 * Give a file that arrived without a name of its own a usable one.
 *
 * Chrome hands every pasted screenshot over as `image.png` and Safari as an
 * empty string, so two pastes into one message produced two chips reading
 * exactly the same thing, and two files on disk that only their upload ids
 * told apart. A file dropped from a file manager keeps the name it came with:
 * that one was chosen by someone and means something.
 */
export function nameArrival(file: File, at: Date): File {
	const stem = file.name.replace(/\.[a-z0-9]{1,5}$/i, '').trim().toLowerCase();
	if (!GENERIC_STEMS.has(stem)) return file;
	const mime = file.type.toLowerCase().split(';')[0].trim();
	return new File([file], `pasted-${stamp(at)}.${MIME_EXTENSIONS[mime] ?? 'bin'}`, {
		type: file.type
	});
}

/** `20260913-143205` — sortable, and legal in a filename on every platform. */
function stamp(at: Date): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	const date = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`;
	return `${date}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
}
