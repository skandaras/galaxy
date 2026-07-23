import { exec as cpExec } from 'node:child_process';
import { join } from 'node:path';
import { env } from '$env/dynamic/private';
import { dataDir } from '$lib/server/db';

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
class DockerExecutor implements CommandExecutor {
	readonly kind = 'docker' as const;

	constructor(
		private apiUrl: string,
		private image: string,
		private volume: string,
		private network: string | null
	) {}

	private async api(path: string, init?: RequestInit): Promise<Response> {
		const res = await fetch(`${this.apiUrl}${path}`, {
			...init,
			headers: { 'content-type': 'application/json', ...init?.headers }
		});
		return res;
	}

	async exec(command: string, opts: { cwdRel: string; timeoutMs?: number }): Promise<ExecResult> {
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
			const wait = await this.api(
				`/containers/${Id}/wait`,
				{ method: 'POST', signal: AbortSignal.timeout(timeoutMs) }
			);
			const { StatusCode } = wait.ok ? await wait.json() : { StatusCode: 124 };
			const logsRes = await this.api(`/containers/${Id}/logs?stdout=1&stderr=1`);
			const raw = Buffer.from(await logsRes.arrayBuffer());
			const { stdout, stderr } = demuxDockerLogs(raw);
			return {
				code: StatusCode,
				stdout: stdout.slice(0, MAX_OUTPUT),
				stderr: stderr.slice(0, MAX_OUTPUT)
			};
		} finally {
			await this.api(`/containers/${Id}?force=true`, { method: 'DELETE' }).catch(() => {});
		}
	}
}

/** Docker multiplexes stdout/stderr into 8-byte-header frames. */
export function demuxDockerLogs(buf: Buffer): { stdout: string; stderr: string } {
	let stdout = '';
	let stderr = '';
	let offset = 0;
	while (offset + 8 <= buf.length) {
		const streamType = buf[offset];
		const size = buf.readUInt32BE(offset + 4);
		const payload = buf.subarray(offset + 8, offset + 8 + size).toString('utf8');
		if (streamType === 2) stderr += payload;
		else stdout += payload;
		offset += 8 + size;
	}
	// Not multiplexed (tty container) — treat the whole thing as stdout.
	if (!stdout && !stderr && buf.length) stdout = buf.toString('utf8');
	return { stdout, stderr };
}

let cached: CommandExecutor | null = null;

export function getExecutor(): CommandExecutor {
	if (cached) return cached;
	const kind = env.CODING_EXECUTOR || 'local';
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
