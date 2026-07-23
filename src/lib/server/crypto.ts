import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { env } from '$env/dynamic/private';
import { dataDir } from '$lib/server/db';

// API keys are encrypted at rest with AES-256-GCM. The master key comes from
// SECRET_KEY (64 hex chars) or, failing that, an auto-generated key file in
// DATA_DIR — losing it means re-entering provider keys, nothing worse.
let cachedKey: Buffer | null = null;

function masterKey(): Buffer {
	if (cachedKey) return cachedKey;
	if (env.SECRET_KEY) {
		const key = Buffer.from(env.SECRET_KEY, 'hex');
		if (key.length !== 32) throw new Error('SECRET_KEY must be 64 hex characters (32 bytes)');
		cachedKey = key;
		return key;
	}
	const keyFile = join(dataDir, 'galaxy.key');
	if (existsSync(keyFile)) {
		cachedKey = Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'hex');
	} else {
		cachedKey = randomBytes(32);
		writeFileSync(keyFile, cachedKey.toString('hex'), { mode: 0o600 });
	}
	return cachedKey;
}

export function encryptSecret(plain: string): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', masterKey(), iv);
	const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
	return ['v1', iv.toString('hex'), cipher.getAuthTag().toString('hex'), ct.toString('hex')].join(
		':'
	);
}

export function decryptSecret(enc: string): string {
	const [version, ivHex, tagHex, ctHex] = enc.split(':');
	if (version !== 'v1') throw new Error(`Unknown secret format: ${version}`);
	const decipher = createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(ivHex, 'hex'));
	decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
	return Buffer.concat([decipher.update(Buffer.from(ctHex, 'hex')), decipher.final()]).toString(
		'utf8'
	);
}
