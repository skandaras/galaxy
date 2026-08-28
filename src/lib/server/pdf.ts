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

/**
 * Generous for a document, short enough that a runaway compile cannot sit
 * forever. The headroom is for a cold package cache: the first document to
 * import something spends this budget downloading it rather than typesetting.
 */
const COMPILE_TIMEOUT_MS = 60_000;

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
 * Where Typst keeps `@preview` packages it has downloaded, and any local ones.
 *
 * Under DATA_DIR, which is a volume, so a package is fetched once for the
 * instance rather than once per document — and, more to the point, survives a
 * redeploy. Typst's own default would put it in the container's `~/.cache`,
 * which every new image throws away.
 */
const packagesDir = () => join(dataDir, 'typst');

/**
 * Compile Typst markup to PDF bytes.
 *
 * `--root` is the throwaway directory the source was written into, which is the
 * confinement that matters: a document cannot read a file outside it, and says
 * so plainly when it tries. Packages are a different question — Typst has no
 * offline mode, so an `@preview` import reaches packages.typst.org wherever the
 * instance has egress. That is allowed on purpose (cetz and friends are most of
 * what makes a typeset document worth having) and it is what the compiler runs
 * from, not something a document can direct elsewhere.
 *
 * A failure throws with the compiler's own diagnostics, which is the useful
 * part — the agent loop hands that text straight back to the model, and it
 * fixes its own markup from it. An instance with no egress gets a network error
 * naming the package, which is as clear as this can be made.
 */
export async function compileTypst(source: string): Promise<Buffer> {
	if (!source.trim()) throw new TypstError('The document is empty.');

	const scratch = join(dataDir, 'tmp');
	mkdirSync(scratch, { recursive: true });
	const packages = packagesDir();
	mkdirSync(packages, { recursive: true });
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
					// Outside the throwaway directory, so what one document downloads
					// the next one already has. TYPST_PACKAGE_PATH is the @local
					// namespace and TYPST_PACKAGE_CACHE_PATH the @preview downloads;
					// both are set so nothing Typst writes lands outside DATA_DIR.
					TYPST_PACKAGE_PATH: packages,
					TYPST_PACKAGE_CACHE_PATH: packages
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
