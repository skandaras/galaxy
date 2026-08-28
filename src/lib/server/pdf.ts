import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { dataDir } from '$lib/server/db';

const run = promisify(execFile);

/**
 * The Typst binary, installed into the image by the Dockerfile.
 *
 * Typst rather than LaTeX because the app image is alpine: a usable TeX
 * distribution is measured in gigabytes, while this is one ~30 MB static binary
 * that embeds its own fonts, needs no network, and compiles in milliseconds.
 * Its markup is close enough to Markdown that a model writes it without a
 * fight, which was the other half of the decision.
 */
const TYPST_BIN = process.env.TYPST_BIN || 'typst';

/** Generous for a document, short enough that a runaway compile cannot sit forever. */
const COMPILE_TIMEOUT_MS = 30_000;

/** A PDF large enough to be a mistake rather than a document. */
const MAX_PDF_BYTES = 25 * 1024 * 1024;

export class TypstError extends Error {}

let available: boolean | null = null;

/**
 * Whether this instance can make PDFs at all, probed once and remembered.
 *
 * Callers use it to leave `create_pdf` out of a turn's toolset entirely, the
 * same way web search is only offered when it is configured — an instance
 * without the binary should be quietly unable to write PDFs rather than
 * offering a tool that always throws.
 */
export async function typstAvailable(): Promise<boolean> {
	if (available !== null) return available;
	try {
		await run(TYPST_BIN, ['--version'], { timeout: 10_000 });
		available = true;
	} catch {
		available = false;
	}
	return available;
}

/**
 * The probe's answer without waiting for it.
 *
 * Assembling a turn's toolset is synchronous, so it cannot await the probe.
 * `startBoot` kicks it off at startup, which means this is settled long before
 * the first message; a request that somehow beats it simply goes without the
 * tool for one turn rather than blocking on a subprocess.
 */
export function typstReady(): boolean {
	return available === true;
}

/** Forget the probe. Tests only. */
export function resetTypstProbe(): void {
	available = null;
}

/**
 * Compile Typst markup to PDF bytes.
 *
 * The compile is sealed in a throwaway directory: `--root` keeps any file
 * reference inside it, and the package cache is pointed at an empty path so an
 * `@preview` import fails immediately instead of reaching for the network from
 * a server that may not have any.
 *
 * A failure throws with the compiler's own diagnostics, which is the useful
 * part — the agent loop hands that text straight back to the model, and it
 * fixes its own markup from it.
 */
export async function compileTypst(source: string): Promise<Buffer> {
	if (!source.trim()) throw new TypstError('The document is empty.');

	const scratch = join(dataDir, 'tmp');
	mkdirSync(scratch, { recursive: true });
	const dir = mkdtempSync(join(scratch, 'typst-'));
	try {
		const input = join(dir, 'main.typ');
		const output = join(dir, 'main.pdf');
		writeFileSync(input, source, 'utf8');
		try {
			await run(TYPST_BIN, ['compile', '--root', dir, input, output], {
				timeout: COMPILE_TIMEOUT_MS,
				maxBuffer: 4 * 1024 * 1024,
				env: {
					...process.env,
					// Both are consulted; an empty directory under the scratch dir
					// means "no packages", not "go and fetch them".
					TYPST_PACKAGE_PATH: join(dir, 'packages'),
					TYPST_PACKAGE_CACHE_PATH: join(dir, 'packages')
				}
			});
		} catch (err) {
			throw new TypstError(diagnostics(err));
		}
		const pdf = readFileSync(output);
		if (pdf.length > MAX_PDF_BYTES) {
			throw new TypstError(
				`The PDF came to ${Math.round(pdf.length / (1024 * 1024))} MB, past the ${MAX_PDF_BYTES / (1024 * 1024)} MB limit.`
			);
		}
		return pdf;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Typst writes its errors to stderr; everything else is a fallback. */
function diagnostics(err: unknown): string {
	const e = err as { stderr?: unknown; killed?: boolean; message?: string };
	if (e?.killed) return `The compile ran past ${COMPILE_TIMEOUT_MS / 1000}s and was stopped.`;
	const stderr = typeof e?.stderr === 'string' ? e.stderr.trim() : '';
	if (stderr) return stderr.slice(0, 4_000);
	if (typeof e?.message === 'string' && /ENOENT/.test(e.message)) {
		return 'The Typst compiler is not installed on this instance.';
	}
	return String(e?.message ?? err);
}
