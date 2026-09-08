import { availableParallelism } from 'node:os';
import { describe, expect, it } from 'vitest';
import { DockerExecutor, demuxDockerLogs, resolveExecutorKind } from './executor';

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

	it('recognises a tty stream longer than a header, too', () => {
		// The old version inferred "not framed" from having parsed nothing, which
		// it could only know at the end. This decides on the first eight bytes,
		// because a streaming reader has to commit before it has seen the rest.
		const text = 'plain terminal output, well past eight bytes';
		expect(demuxDockerLogs(Buffer.from(text, 'utf8'))).toEqual({ stdout: text, stderr: '' });
	});
});

/**
 * The docker path, which no test had ever run.
 *
 * `demuxDockerLogs` was covered on three-byte inputs and `DockerExecutor` was
 * never instantiated — so the truncation, the timeouts, the cleanup and the
 * concurrency cap were all assertions nobody had made. A stubbed Docker API is
 * enough for every one of them: what is being tested is this file's handling of
 * the daemon's answers, not the daemon.
 */
describe('DockerExecutor against a stubbed daemon', () => {
	const frame = (stream: 1 | 2, text: string) => {
		const payload = Buffer.from(text, 'utf8');
		const header = Buffer.alloc(8);
		header[0] = stream;
		header.writeUInt32BE(payload.length, 4);
		return Buffer.concat([header, payload]);
	};

	/** A daemon that returns `logs`, split into `chunkSize`-byte network reads. */
	function stubDocker(opts: {
		logs: Buffer;
		chunkSize?: number;
		waitDelayMs?: number;
		statusCode?: number;
		/** Refuse a create whose HostConfig carries this key, as Docker does. */
		refuseHostConfigKey?: string;
	}) {
		const calls: { path: string; body?: string; hadSignal: boolean }[] = [];
		const fetchStub = async (url: string | URL, init?: RequestInit): Promise<Response> => {
			const path = String(url).replace('http://docker', '');
			calls.push({ path, body: init?.body as string, hadSignal: !!init?.signal });

			if (path === '/containers/create') {
				const key = opts.refuseHostConfigKey;
				if (key && key in JSON.parse(String(init?.body)).HostConfig) {
					return new Response(
						JSON.stringify({ message: `range of CPUs is from 0.01 to 1.00, as there are only 1 CPUs available` }),
						{ status: 400 }
					);
				}
				return new Response(JSON.stringify({ Id: 'abc' }), { status: 201 });
			}
			if (path.endsWith('/start')) return new Response(null, { status: 204 });
			if (path.endsWith('/wait')) {
				if (opts.waitDelayMs) {
					// Respect the caller's deadline the way fetch does: reject.
					await new Promise((resolve, reject) => {
						const timer = setTimeout(resolve, opts.waitDelayMs);
						init?.signal?.addEventListener('abort', () => {
							clearTimeout(timer);
							const err = new Error('aborted');
							err.name = 'TimeoutError';
							reject(err);
						});
					});
				}
				return new Response(JSON.stringify({ StatusCode: opts.statusCode ?? 0 }), { status: 200 });
			}
			if (path.includes('/logs')) {
				const size = opts.chunkSize ?? (opts.logs.length || 1);
				const stream = new ReadableStream({
					start(controller) {
						for (let i = 0; i < opts.logs.length; i += size) {
							controller.enqueue(new Uint8Array(opts.logs.subarray(i, i + size)));
						}
						controller.close();
					}
				});
				return new Response(stream, { status: 200 });
			}
			return new Response(null, { status: 204 }); // DELETE
		};
		return { calls, fetchStub };
	}

	async function runWith(opts: Parameters<typeof stubDocker>[0], command = 'echo hi') {
		const { calls, fetchStub } = stubDocker(opts);
		const original = globalThis.fetch;
		globalThis.fetch = fetchStub as typeof globalThis.fetch;
		try {
			const exec = new DockerExecutor('http://docker', 'runner:latest', 'vol', null);
			const result = await exec.exec(command, { cwdRel: 'work', timeoutMs: 50 });
			return { result, calls };
		} finally {
			globalThis.fetch = original;
		}
	}

	it('reassembles frames split across network reads', async () => {
		const logs = Buffer.concat([frame(1, 'hello '), frame(2, 'a warning'), frame(1, 'world')]);
		// Three bytes at a time, so headers straddle read boundaries.
		const { result } = await runWith({ logs, chunkSize: 3 });
		expect(result.stdout).toBe('hello world');
		expect(result.stderr).toBe('a warning');
	});

	it('keeps a multi-byte character split across two reads', async () => {
		const logs = frame(1, 'né');
		const { result } = await runWith({ logs, chunkSize: 9 }); // splits the é
		expect(result.stdout).toBe('né');
	});

	it('keeps the head and the tail of oversized output, and says what it dropped', async () => {
		// A megabyte from a command that then reports its error on the last line.
		const noise = 'x'.repeat(1_000_000);
		const logs = frame(1, `START${noise}THE ACTUAL ERROR`);
		const { result } = await runWith({ logs, chunkSize: 64_000 });

		expect(result.stdout.startsWith('START')).toBe(true);
		// The end is the half that used to be thrown away, and on a failing
		// command it is the half that says what went wrong.
		expect(result.stdout.endsWith('THE ACTUAL ERROR')).toBe(true);
		expect(result.stdout).toContain('characters dropped');
		expect(result.stdout.length).toBeLessThan(250_000);
	});

	it('reports a timed-out command as 124 rather than throwing', async () => {
		// AbortSignal.timeout rejects, so the 124 the code reaches for was
		// unreachable — the caller got an AbortError instead.
		const { result } = await runWith({ logs: frame(1, 'partial'), waitDelayMs: 5_000 });
		expect(result.code).toBe(124);
		expect(result.stderr).toContain('timed out');
		expect(result.stdout).toBe('partial');
	});

	it('puts a deadline on every Docker call, not just the wait', async () => {
		const { calls } = await runWith({ logs: frame(1, 'ok') });
		const paths = calls.map((c) => c.path);
		expect(paths).toEqual([
			'/containers/create',
			'/containers/abc/start',
			'/containers/abc/wait',
			'/containers/abc/logs?stdout=1&stderr=1',
			'/containers/abc?force=true'
		]);
		expect(calls.every((c) => c.hadSignal)).toBe(true);
	});

	it('removes the container even when the command timed out', async () => {
		const { calls } = await runWith({ logs: frame(1, ''), waitDelayMs: 5_000 });
		expect(calls.some((c) => c.path === '/containers/abc?force=true')).toBe(true);
	});

	it('caps the container resources it asks for', async () => {
		const { calls } = await runWith({ logs: frame(1, 'ok') });
		const body = JSON.parse(calls[0].body!);
		expect(body.HostConfig.Memory).toBe(1024 * 1024 * 1024);
		expect(body.HostConfig.PidsLimit).toBe(256);
		// Neither of these existed: one runner could take every core, and the
		// daemon's own log file grew to whatever the command wrote.
		expect(body.HostConfig.NanoCpus).toBeGreaterThan(0);
		expect(body.HostConfig.LogConfig.Config['max-size']).toBeTruthy();
	});
});

describe('the global runner limit', () => {
	it('bounds containers across runs, not just within one batch', async () => {
		// `toolConcurrency` caps one batch at four. Nothing capped the total, so
		// two sessions gave eight containers and the one-off git commands — which
		// never went through the batch limiter — were on top of that.
		process.env.RUNNER_CONCURRENCY = '2';
		let inFlight = 0;
		let peak = 0;
		const original = globalThis.fetch;
		globalThis.fetch = (async (url: string | URL) => {
			const path = String(url);
			if (path.endsWith('/containers/create')) {
				inFlight++;
				peak = Math.max(peak, inFlight);
				return new Response(JSON.stringify({ Id: 'abc' }), { status: 201 });
			}
			if (path.endsWith('/wait')) {
				await new Promise((r) => setTimeout(r, 10));
				return new Response(JSON.stringify({ StatusCode: 0 }), { status: 200 });
			}
			if (path.includes('/logs')) return new Response(new Uint8Array(0), { status: 200 });
			if (path.includes('force=true')) {
				inFlight--;
				return new Response(null, { status: 204 });
			}
			return new Response(null, { status: 204 });
		}) as typeof globalThis.fetch;
		try {
			const exec = new DockerExecutor('http://docker', 'runner:latest', 'vol', null);
			await Promise.all(
				Array.from({ length: 6 }, () => exec.exec('echo hi', { cwdRel: 'w', timeoutMs: 1_000 }))
			);
		} finally {
			globalThis.fetch = original;
			delete process.env.RUNNER_CONCURRENCY;
		}
		expect(peak).toBeLessThanOrEqual(2);
	});
});

/**
 * The bug this file could not see.
 *
 * `caps the container resources it asks for` passed against a body Docker would
 * have refused: the stub answered 201 to every create, so it asserted the shape
 * of the request and never that the daemon would take it. Shipping
 * `NanoCpus: 2e9` to a one-CPU host 400'd every create, and because a failing
 * tool call is returned to the model rather than ending the run, the agent spent
 * fifty model round-trips per leg rediscovering that its runner was dead.
 */
describe('a resource hint the host will not take', () => {
	const frame = (stream: 1 | 2, text: string) => {
		const payload = Buffer.from(text, 'utf8');
		const header = Buffer.alloc(8);
		header[0] = stream;
		header.writeUInt32BE(payload.length, 4);
		return Buffer.concat([header, payload]);
	};

	async function createBodies(opts: { cpus?: string; refuse?: string }) {
		const calls: string[] = [];
		const original = globalThis.fetch;
		if (opts.cpus !== undefined) process.env.RUNNER_CPUS = opts.cpus;
		globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
			const path = String(url);
			if (path.endsWith('/containers/create')) {
				calls.push(String(init?.body));
				if (opts.refuse && opts.refuse in JSON.parse(String(init?.body)).HostConfig) {
					return new Response(JSON.stringify({ message: 'range of CPUs is from 0.01 to 1.00' }), {
						status: 400
					});
				}
				return new Response(JSON.stringify({ Id: 'abc' }), { status: 201 });
			}
			if (path.endsWith('/wait')) {
				return new Response(JSON.stringify({ StatusCode: 0 }), { status: 200 });
			}
			if (path.includes('/logs')) return new Response(frame(1, 'ok'), { status: 200 });
			return new Response(null, { status: 204 });
		}) as typeof globalThis.fetch;
		try {
			const exec = new DockerExecutor('http://docker', 'runner:latest', 'vol', null);
			const result = await exec.exec('echo hi', { cwdRel: 'w', timeoutMs: 1_000 });
			return { bodies: calls.map((b) => JSON.parse(b).HostConfig), result };
		} finally {
			globalThis.fetch = original;
			delete process.env.RUNNER_CPUS;
		}
	}

	it('never asks for more CPUs than the host has', async () => {
		// The assertion that would have caught it. RUNNER_CPUS is clamped by
		// availableParallelism, so no configured value can produce an invalid ask.
		const { bodies } = await createBodies({ cpus: '64' });
		expect(bodies[0].NanoCpus).toBeLessThanOrEqual(availableParallelism() * 1e9);
		expect(bodies[0].NanoCpus).toBeGreaterThanOrEqual(0.01 * 1e9);
	});

	it('sends no CPU limit at all when it is switched off', async () => {
		const { bodies } = await createBodies({ cpus: '0' });
		expect(bodies[0]).not.toHaveProperty('NanoCpus');
		// Switching off a hint must not switch off the isolation.
		expect(bodies[0].Memory).toBe(1024 * 1024 * 1024);
		expect(bodies[0].PidsLimit).toBe(256);
	});

	it('retries without the hints when the daemon refuses them', async () => {
		const { bodies, result } = await createBodies({ refuse: 'NanoCpus' });
		expect(bodies).toHaveLength(2);
		expect(bodies[0]).toHaveProperty('NanoCpus');
		expect(bodies[1]).not.toHaveProperty('NanoCpus');
		expect(bodies[1]).not.toHaveProperty('LogConfig');
		// And the command actually ran, rather than the feature going down over a
		// field that was only ever advisory.
		expect(result.stdout).toBe('ok');
	});

	it('keeps every isolation field on the retry', async () => {
		const { bodies } = await createBodies({ refuse: 'NanoCpus' });
		expect(bodies[1].Memory).toBe(1024 * 1024 * 1024);
		expect(bodies[1].PidsLimit).toBe(256);
		expect(bodies[1].Binds).toEqual(['vol:/data']);
	});
});
