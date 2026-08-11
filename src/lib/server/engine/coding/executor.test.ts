import { describe, expect, it } from 'vitest';
import { demuxDockerLogs, resolveExecutorKind } from './executor';

describe('resolveExecutorKind', () => {
	it('accepts the two it knows', () => {
		expect(resolveExecutorKind('local')).toBe('local');
		expect(resolveExecutorKind('docker')).toBe('docker');
	});

	it('treats unset as local, which is the dev and test default', () => {
		expect(resolveExecutorKind(undefined)).toBe('local');
		expect(resolveExecutorKind('')).toBe('local');
	});

	it('refuses a typo rather than quietly unsandboxing the agent', () => {
		// This is the whole point: `dokcer` used to fall through to the local
		// executor, running the agent's bash inside the app container with
		// SECRET_KEY in its environment, and nothing said so anywhere.
		expect(() => resolveExecutorKind('dokcer')).toThrow(/must be "local" or "docker"/);
		expect(() => resolveExecutorKind('Docker')).toThrow();
		expect(() => resolveExecutorKind('none')).toThrow();
	});
});

describe('demuxDockerLogs', () => {
	/** Docker frames each chunk with a stream byte and a big-endian length. */
	const frame = (stream: 1 | 2, text: string) => {
		const payload = Buffer.from(text, 'utf8');
		const header = Buffer.alloc(8);
		header[0] = stream;
		header.writeUInt32BE(payload.length, 4);
		return Buffer.concat([header, payload]);
	};

	it('splits stdout from stderr', () => {
		const buf = Buffer.concat([frame(1, 'out'), frame(2, 'err'), frame(1, 'more')]);
		expect(demuxDockerLogs(buf)).toEqual({ stdout: 'outmore', stderr: 'err' });
	});

	it('passes an unframed tty stream through as stdout', () => {
		expect(demuxDockerLogs(Buffer.from('plain', 'utf8')).stdout).toBe('plain');
	});
});
