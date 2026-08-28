import { describe, expect, it } from 'vitest';
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

	it('refuses to reach the network for a package', async () => {
		// The tool description and the skill both promise this; if the package
		// cache were ever left at its default this test is what notices.
		await expect(compileTypst('#import "@preview/cetz:0.3.1": canvas\n= Hi')).rejects.toThrow(
			TypstError
		);
	});

	it('rejects an empty document before shelling out', async () => {
		await expect(compileTypst('   ')).rejects.toThrow(/empty/i);
	});
});
