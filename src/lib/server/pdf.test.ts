import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '$lib/server/db';
import { compileTypst, resetTypstProbe, typstAvailable, TypstError } from './pdf';

/**
 * The compiler itself, exercised only where it is installed.
 *
 * CI and the production image both have the binary; a contributor's laptop may
 * not, and a suite that fails there for an optional dependency teaches people
 * to ignore red. `describe.skipIf` keeps that honest — the tests either run for
 * real or say plainly that they did not.
 */
resetTypstProbe();
const installed = await typstAvailable();

describe('typstAvailable', () => {
	it('answers the same way twice', async () => {
		expect(await typstAvailable()).toBe(installed);
	});
});

describe.skipIf(!installed)('compileTypst', () => {
	it('produces a PDF', async () => {
		const pdf = await compileTypst('= Hello\n\nA short document.');
		expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
		expect(pdf.length).toBeGreaterThan(500);
	});

	it('sets tables and maths without any package', async () => {
		const pdf = await compileTypst(
			[
				'#set page(paper: "a4")',
				'= Report',
				'#table(columns: 2, [*Month*], [*Spend*], [January], [1204])',
				'$ sum_(i=1)^n i = (n(n+1))/2 $'
			].join('\n\n')
		);
		expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
	});

	it("hands back the compiler's diagnostics, which is what the model fixes from", async () => {
		await expect(compileTypst('= Broken\n#table(columns: 2\n')).rejects.toThrow(TypstError);
		await expect(compileTypst('= Broken\n#table(columns: 2\n')).rejects.toThrow(
			/unclosed delimiter/i
		);
	});

	it('cannot read a file outside the directory it compiles in', async () => {
		// --root is the confinement that matters, and the one thing here worth
		// asserting: the source is model-authored, so a document that could read
		// the filesystem would be reading it on the model's behalf.
		//
		// Package downloads deliberately get no test. Typst has no offline mode,
		// so whether an @preview import resolves depends on whether the machine
		// running the suite has egress — which is why the assertion that used to
		// stand here passed on a sandboxed laptop and failed on CI.
		await expect(compileTypst('= Peek\n\n#read("/../../../etc/hostname")')).rejects.toThrow(
			/outside of project root/
		);
	});

	it('looks for packages under DATA_DIR, not in the throwaway compile directory', async () => {
		// The behaviour a persistent cache buys: what one document downloads, the
		// next one already has, and a redeploy does not throw it away. Exercised
		// with a local package because the registry needs egress, and a test that
		// depends on the network is what put this file in CI's red column.
		const pkg = join(dataDir, 'typst', 'local', 'smoke-pkg', '0.1.0');
		mkdirSync(pkg, { recursive: true });
		writeFileSync(
			join(pkg, 'typst.toml'),
			'[package]\nname = "smoke-pkg"\nversion = "0.1.0"\nentrypoint = "lib.typ"\n'
		);
		writeFileSync(join(pkg, 'lib.typ'), '#let hello() = [Hello from a package]\n');

		const pdf = await compileTypst(
			'#import "@local/smoke-pkg:0.1.0": hello\n\n= Doc\n\n#hello()'
		);
		expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
	});

	it('rejects an empty document before shelling out', async () => {
		await expect(compileTypst('   ')).rejects.toThrow(/empty/i);
	});
});
