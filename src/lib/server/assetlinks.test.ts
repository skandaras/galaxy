import { describe, expect, it } from 'vitest';
import { assetLinks } from './assetlinks';

const PKG = 'net.starbasehome.ai.galaxy';
const FP = 'AA:BB:CC:DD';

describe('assetLinks', () => {
	it('builds the statement Android verifies against', () => {
		expect(assetLinks(PKG, FP)).toEqual([
			{
				relation: ['delegate_permission/common.handle_all_urls'],
				target: {
					namespace: 'android_app',
					package_name: PKG,
					sha256_cert_fingerprints: [FP]
				}
			}
		]);
	});

	it('carries several fingerprints, so a debug and a release build both verify', () => {
		const links = assetLinks(PKG, 'AA:BB, CC:DD ,EE:FF');
		expect(links?.[0].target.sha256_cert_fingerprints).toEqual(['AA:BB', 'CC:DD', 'EE:FF']);
	});

	it('normalises case, because keytool and a pasted fingerprint disagree', () => {
		const links = assetLinks(PKG, 'aa:bb:cc');
		expect(links?.[0].target.sha256_cert_fingerprints).toEqual(['AA:BB:CC']);
	});

	it('tolerates a trailing comma and blank entries', () => {
		const links = assetLinks(PKG, 'AA:BB,,\n');
		expect(links?.[0].target.sha256_cert_fingerprints).toEqual(['AA:BB']);
	});

	// An unconfigured instance has no statement to make. Serving an empty list
	// instead would be a positive claim that no app owns this origin.
	it('is null until both halves are configured', () => {
		expect(assetLinks('', FP)).toBeNull();
		expect(assetLinks(PKG, '')).toBeNull();
		expect(assetLinks(PKG, ' , ')).toBeNull();
		expect(assetLinks('  ', '  ')).toBeNull();
	});
});
