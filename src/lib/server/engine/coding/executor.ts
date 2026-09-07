import { exec as cpExec } from 'node:child_process';
import { join } from 'node:path';
import { env } from '$env/dynamic/private';
import { dataDir } from '$lib/server/db';
import { dockerApiTimeoutMs, runnerConcurrency, runnerCpus } from '../limits';

export interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface CommandExecutor {
	readonly kind: 'local' | 'docker';
	/** Run a shell command with cwd given relative to the data dir. */
	exec(command: string, opts: { cwdRel: string; timeoutMs?: number }): Promise<ExecResult>;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 200_000;
/**
 * How the cap is split when output overruns it.
 *
 * Head-only truncation threw away the end, which on a failing command is the
 * part that says what went wrong — a build that logs every file it compiles and
 * then reports one error gave the agent 200,000 characters of compilation and
 * none of the error. The head is kept because the first lines are usually what
 * the command was and how it started.
 */
const HEAD_OUTPUT = Math.floor(MAX_OUTPUT * 0.4);
const TAIL_OUTPUT = MAX_OUTPUT - HEAD_OUTPUT;

/**
 * A string that will not grow past its bounds, keeping the start and the end.
 *
 * The docker executor used to read the whole log into memory and truncate
 * afterwards, so MAX_OUTPUT bounded what the agent saw and nothing bounded what
 * the process allocated. This bounds it as it arrives.
 */
export class BoundedText {
	private head = '';
	private tail = '';
	private dropped = 0;

	constructor(
		private headMax = HEAD_OUTPUT,
		private tailMax = TAIL_OUTPUT
	) {}

	push(text: string): void {
		let rest = text;
		if (this.head.length < this.headMax) {
			const room = this.headMax - this.head.length;
			this.head += rest.slice(0, room);
			rest = rest.slice(room);
			if (!rest) return;
		}
		// Never concatenate first: one oversized chunk would allocate the very
		// thing this class exists to avoid.
		if (rest.length >= this.tailMax) {
			this.dropped += this.tail.length + rest.length - this.tailMax;
			this.tail = rest.slice(rest.length - this.tailMax);
			return;
		}
		this.tail += rest;
		if (this.tail.length > this.tailMax) {
			const over = this.tail.length - this.tailMax;
			this.tail = this.tail.slice(over);
			this.dropped += over;
		}
	}

	get truncated(): boolean {
		return this.dropped > 0;
	}

	toString(): string {
		if (!this.dropped) return this.head + this.tail;
		return `${this.head}\n\n[… ${this.dropped.toLocaleString('en-US')} characters dropped — the middle of the output exceeded the ${MAX_OUTPUT.toLocaleString('en-US')} character cap …]\n\n${this.tail}`;
	}
}

/**
 * Docker's log stream, one chunk at a time.
 *
 * Frames arrive split across network reads, so the header may straddle a
 * boundary and so may a multi-byte character — the old whole-buffer version
 * decoded each frame independently and mangled any character unlucky enough to
 * span two of them. A streaming decoder per output fixes that as a side effect
 * of doing this incrementally at all.
 */
export class DockerLogDemuxer {
	private leftover: Buffer = Buffer.alloc(0);
	private framed: boolean | null = null;
	private out: BoundedText;
	private err: BoundedText;
	private outDecoder = new TextDecoder('utf-8');
	private errDecoder = new TextDecoder('utf-8');

	constructor(limit?: { headMax: number; tailMax: number }) {
		this.out = new BoundedText(limit?.headMax, limit?.tailMax);
		this.err = new BoundedText(limit?.headMax, limit?.tailMax);
	}

	push(chunk: Buffer): void {
		this.leftover = this.leftover.length ? Buffer.concat([this.leftover, chunk]) : chunk;
		// A container without a tty multiplexes; one with a tty does not, and says
		// so only by not looking like a frame. Decided once, on the first eight
		// bytes, rather than inferred at the end from an empty result.
		if (this.framed === null) {
			if (this.leftover.length < 8) return;
			this.framed = looksLikeFrameHeader(this.leftover);
		}
		if (!this.framed) {
			this.out.push(this.outDecoder.decode(this.leftover, { stream: true }));
			this.leftover = Buffer.alloc(0);
			return;
		}
		let offset = 0;
		while (offset + 8 <= this.leftover.length) {
			const size = this.leftover.readUInt32BE(offset + 4);
			if (offset + 8 + size > this.leftover.length) break; // frame still arriving
			const streamType = this.leftover[offset];
			const payload = this.leftover.subarray(offset + 8, offset + 8 + size);
			if (streamType === 2) this.err.push(this.errDecoder.decode(payload, { stream: true }));
			else this.out.push(this.outDecoder.decode(payload, { stream: true }));
			offset += 8 + size;
		}
		this.leftover = this.leftover.subarray(offset);
	}

	finish(): { stdout: string; stderr: string } {
		// A tty stream shorter than a header never got a verdict; it is not framed.
		if (this.framed === null && this.leftover.length) {
			this.out.push(this.outDecoder.decode(this.leftover, { stream: true }));
			this.leftover = Buffer.alloc(0);
		}
		this.out.push(this.outDecoder.decode());
		this.err.push(this.errDecoder.decode());
		return { stdout: this.out.toString(), stderr: this.err.toString() };
	}
}

/** Stream byte 0-2, then three zero bytes before the big-endian length. */
function looksLikeFrameHeader(buf: Buffer): boolean {
	return buf[0] <= 2 && buf[1] === 0 && buf[2] === 0 && buf[3] === 0;
}

/**
 * Runner containers in flight, host-wide.
 *
 * Module-level rather than per-executor, because the cap is about the host and
 * every caller shares one executor anyway. Waiters are woken in order, so a
 * batch cannot starve the one-off git commands queued behind it.
 */
let runnersInFlight = 0;
const runnerQueue: (() => void)[] = [];

async function withRunnerSlot<T>(fn: () => Promise<T>): Promise<T> {
	if (runnersInFlight >= runnerConcurrency()) {
		await new Promise<void>((resolve) => runnerQueue.push(resolve));
	}
	runnersInFlight++;
	try {
		return await fn();
	} finally {
		runnersInFlight--;
		runnerQueue.shift()?.();
	}
}

/**
 * Runs commands as child processes of the app itself. Fine for development;
 * production should use the docker executor so agent-driven commands are
 * isolated in throwaway runner containers.
 */
class LocalExecutor implements CommandExecutor {
	readonly kind = 'local' as const;

	exec(command: string, opts: { cwdRel: string; timeoutMs?: number }): Promise<ExecResult> {
		return new Promise((resolve) => {
			cpExec(
				command,
				{
					cwd: join(dataDir, opts.cwdRel),
					timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
					maxBuffer: MAX_OUTPUT,
					env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
				},
				(err, stdout, stderr) => {
					resolve({
						code: err ? ((err as { code?: number }).code ?? 1) : 0,
						stdout: String(stdout).slice(0, MAX_OUTPUT),
						stderr: String(stderr).slice(0, MAX_OUTPUT)
					});
				}
			);
		});
	}
}

/**
 * Runs each command in a fresh sibling container via the (restricted) Docker
 * API exposed by docker-socket-proxy. The shared data volume is mounted at
 * /data so workspaces line up with the app's DATA_DIR-relative paths.
 */
export class DockerExecutor implements CommandExecutor {
	readonly kind = 'docker' as const;

	constructor(
		private apiUrl: string,
		private image: string,
		private volume: string,
		private network: string | null
	) {}

	/**
	 * Every Docker call gets a deadline. Only `/wait` used to have one, so a
	 * proxy that accepted the connection and went quiet hung create, start, logs
	 * or cleanup indefinitely — whatever timeout the caller had asked for.
	 */
	private async api(path: string, init?: RequestInit, timeoutMs?: number): Promise<Response> {
		return fetch(`${this.apiUrl}${path}`, {
			...init,
			signal: init?.signal ?? AbortSignal.timeout(timeoutMs ?? dockerApiTimeoutMs()),
			headers: { 'content-type': 'application/json', ...init?.headers }
		});
	}

	exec(command: string, opts: { cwdRel: string; timeoutMs?: number }): Promise<ExecResult> {
		return withRunnerSlot(() => this.run(command, opts));
	}

	private async run(
		command: string,
		opts: { cwdRel: string; timeoutMs?: number }
	): Promise<ExecResult> {
		const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const create = await this.api('/containers/create', {
			method: 'POST',
			body: JSON.stringify({
				Image: this.image,
				Cmd: ['sh', '-lc', command],
				WorkingDir: `/data/${opts.cwdRel}`,
				Env: ['GIT_TERMINAL_PROMPT=0'],
				HostConfig: {
					Binds: [`${this.volume}:/data`],
					...(this.network ? { NetworkMode: this.network } : {}),
					Memory: 1024 * 1024 * 1024,
					// A limit on the daemon's side as well as ours. We stop reading
					// past the cap, but without this the log file itself grows to
					// whatever the command writes, on the host's disk.
					LogConfig: { Type: 'json-file', Config: { 'max-size': '16m', 'max-file': '1' } },
					NanoCpus: Math.round(runnerCpus() * 1e9),
					PidsLimit: 256
				}
			})
		});
		if (!create.ok) {
			throw new Error(`Runner create failed (${create.status}): ${await create.text()}`);
		}
		const { Id } = await create.json();
		try {
			const start = await this.api(`/containers/${Id}/start`, { method: 'POST' });
			if (!start.ok && start.status !== 304) {
				throw new Error(`Runner start failed (${start.status})`);
			}
			// `AbortSignal.timeout` throws rather than returning a non-ok response,
			// so the 124 below was unreachable: a command that ran over its deadline
			// raised AbortError instead of reporting the timeout code the caller was
			// written to expect.
			let timedOut = false;
			const wait = await this.api(`/containers/${Id}/wait`, {
				method: 'POST',
				signal: AbortSignal.timeout(timeoutMs)
			}).catch((err) => {
				if (!isAbort(err)) throw err;
				timedOut = true;
				return null;
			});
			const StatusCode: number = wait?.ok ? (await wait.json()).StatusCode : 124;
			const { stdout, stderr } = await this.readLogs(Id);
			return {
				code: StatusCode,
				stdout,
				stderr: timedOut
					? `${stderr}\n[timed out after ${Math.round(timeoutMs / 1000)}s and was killed]`.trimStart()
					: stderr
			};
		} finally {
			await this.api(`/containers/${Id}?force=true`, { method: 'DELETE' }).catch(() => {});
		}
	}

	/**
	 * Read the container's output without ever holding all of it.
	 *
	 * This used to be `Buffer.from(await res.arrayBuffer())` followed by a demux
	 * that built two more full copies as strings, and only then a slice to
	 * MAX_OUTPUT. So the cap bounded what the agent saw and nothing bounded what
	 * the process allocated: a command emitting a couple of gigabytes cost that
	 * much in the *app*, not in the sandbox meant to contain it. The local
	 * executor has bounded this at source with `maxBuffer` all along — the docker
	 * path, which exists precisely for isolation, was the unsafe one.
	 */
	private async readLogs(id: string): Promise<{ stdout: string; stderr: string }> {
		const res = await this.api(`/containers/${id}/logs?stdout=1&stderr=1`);
		const demuxer = new DockerLogDemuxer();
		if (!res.body) return demuxer.finish();
		const reader = res.body.getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				demuxer.push(Buffer.from(value));
			}
		} finally {
			reader.releaseLock();
		}
		return demuxer.finish();
	}
}

function isAbort(err: unknown): boolean {
	const name = (err as { name?: unknown })?.name;
	return name === 'AbortError' || name === 'TimeoutError';
}

/**
 * Docker multiplexes stdout/stderr into 8-byte-header frames.
 *
 * Kept for callers holding a whole buffer already; the executor itself streams.
 * One implementation either way, so the two cannot drift.
 */
export function demuxDockerLogs(buf: Buffer): { stdout: string; stderr: string } {
	const demuxer = new DockerLogDemuxer();
	if (buf.length) demuxer.push(buf);
	return demuxer.finish();
}

let cached: CommandExecutor | null = null;

/**
 * Which executor `CODING_EXECUTOR` names, or a refusal.
 *
 * An unrecognised value used to fall through to the local executor, which runs
 * the agent's bash *inside the app container* — with SECRET_KEY and the
 * database in reach. Both compose services set `docker`, so a typo there was a
 * silent un-sandboxing with nothing anywhere to say so. The one safe reading of
 * "I asked for a sandbox" is not "never mind then", so this throws and the
 * container fails to start.
 *
 * Unset still means local: that is the dev and test default, and it is chosen
 * by omission rather than mistyped.
 */
export function resolveExecutorKind(raw: string | undefined): 'local' | 'docker' {
	const kind = raw || 'local';
	if (kind !== 'local' && kind !== 'docker') {
		throw new Error(
			`CODING_EXECUTOR must be "local" or "docker", got ${JSON.stringify(kind)}. ` +
				'Refusing to start rather than silently running agent commands unsandboxed.'
		);
	}
	return kind;
}

export function getExecutor(): CommandExecutor {
	if (cached) return cached;
	const kind = resolveExecutorKind(env.CODING_EXECUTOR);
	if (kind === 'docker') {
		const apiUrl = env.DOCKER_API_URL;
		if (!apiUrl) throw new Error('CODING_EXECUTOR=docker requires DOCKER_API_URL');
		cached = new DockerExecutor(
			apiUrl.replace(/\/$/, ''),
			env.RUNNER_IMAGE || 'node:22-alpine',
			env.DATA_VOLUME || 'galaxy-data',
			env.RUNNER_NETWORK || null
		);
	} else {
		cached = new LocalExecutor();
	}
	return cached;
}
