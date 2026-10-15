import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db, runMigrations } from '$lib/server/db';
import {
	chats,
	codeSessions,
	mcpServers,
	mcpTools,
	models,
	providers,
	toolSettings,
	usageLog
} from '$lib/server/db/schema';
import { setSetting } from '$lib/server/settings';
import { loadState, recordChecks, setPlan } from './state';
import { sessionOverview, windowFor } from './overview';
import type { CodeSession } from './session';

beforeAll(() => {
	runMigrations();
});

function fixture(repoUrl = 'https://github.com/o/r.git') {
	const id = randomUUID();
	const chatId = `overview-${id}`;
	const userId = `user-${id}`;
	const now = new Date();
	db.insert(chats)
		.values({ id: chatId, userId, mode: 'code', title: 'Overview', createdAt: now, updatedAt: now })
		.run();
	const session: CodeSession = {
		chatId,
		userId,
		repoUrl,
		repoName: 'repo',
		baseBranch: 'main',
		workBranch: 'galaxy/session',
		workspaceRel: `workspaces/${id}`,
		mode: 'implement',
		prUrl: null,
		createdAt: now
	};
	db.insert(codeSessions).values(session).run();
	return { chatId, userId, session };
}

function providerAndModel(id: string, modelKey: string, contextWindow: number | null, providerId = `p-${id}`) {
	db.insert(providers)
		.values({
			id: providerId,
			name: providerId,
			kind: 'openai-compatible',
			baseUrl: 'http://example.invalid/v1',
			apiKeyEnc: null,
			enabled: true,
			createdAt: new Date()
		})
		.run();
	db.insert(models)
		.values({
			id,
			providerId,
			modelKey,
			displayName: id,
			contextWindow,
			supportsTools: true,
			supportsVision: false,
			promptCostPerMTok: null,
			completionCostPerMTok: null,
			cacheMode: 'auto',
			enabled: true
		})
		.run();
}

function usage(
	id: string,
	chatId: string | null,
	userId: string | null,
	options: { ts: number; task?: string; status?: 'ok' | 'error'; promptTokens?: number; completionTokens?: number; modelKey?: string }
) {
	db.insert(usageLog)
		.values({
			id,
			chatId,
			userId,
			ts: new Date(options.ts),
			task: options.task ?? 'coding',
			modelKey: options.modelKey ?? 'overview-model',
			promptTokens: options.promptTokens ?? 100,
			completionTokens: options.completionTokens ?? 10,
			status: options.status ?? 'ok'
		})
		.run();
}

describe('sessionOverview context and window selection', () => {
	it('uses the latest usable coding usage row for this chat and owner', () => {
		const { chatId, userId, session } = fixture();
		providerAndModel('overview-chat-model', 'overview-model', 32_000);
		db.update(chats).set({ modelId: 'overview-chat-model' }).where(eq(chats.id, chatId)).run();
		const base = Date.now();
		usage(`usage-${randomUUID()}`, chatId, userId, { ts: base, promptTokens: 100, completionTokens: 20 });
		usage(`usage-${randomUUID()}`, chatId, userId, {
			ts: base + 1,
			task: 'chat',
			promptTokens: 900,
			completionTokens: 5
		});
		usage(`usage-${randomUUID()}`, chatId, userId, { ts: base + 2, promptTokens: 0 });
		usage(`usage-${randomUUID()}`, chatId, `other-${userId}`, {
			ts: base + 3,
			promptTokens: 700
		});
		usage(`usage-${randomUUID()}`, null, userId, { ts: base + 4, promptTokens: 800 });
		usage(`usage-${randomUUID()}`, chatId, userId, {
			ts: base + 5,
			promptTokens: 240,
			completionTokens: 60
		});

		const context = sessionOverview(session, userId).context;
		expect(context).toEqual({
			usedTokens: 300,
			contextWindow: 32_000,
			modelKey: 'overview-model',
			at: base + 5
		});
	});

	it('uses a model key only when every matching row agrees on its context window', () => {
		providerAndModel('window-chat-choice', 'window-duplicate', 64_000);
		providerAndModel('window-other-choice', 'window-duplicate', 16_000);
		providerAndModel('window-single-choice', 'window-single', 8_000);
		providerAndModel('window-agree-a', 'window-agree', 32_000);
		providerAndModel('window-agree-b', 'window-agree', 32_000);
		providerAndModel('window-null-only', 'window-null', null);
		expect(windowFor('window-duplicate')).toBeNull();
		expect(windowFor('window-single')).toBe(8_000);
		expect(windowFor('window-agree')).toBe(32_000);
		expect(windowFor('window-null')).toBeNull();
		expect(windowFor('window-missing')).toBeNull();
	});

	it('returns null context when no usable usage rows exist', () => {
		const { chatId, userId, session } = fixture();
		usage(`usage-${randomUUID()}`, chatId, userId, {
			ts: Date.now(),
			promptTokens: 0
		});
		expect(sessionOverview(session, userId).context).toBeNull();
	});
});

describe('sessionOverview privacy and state', () => {
	it('rebuilds a safe GitHub link and omits unsupported or credential-bearing remotes', () => {
		const { userId, session } = fixture();
		const safe = sessionOverview(session, userId);
		expect(safe.environment.repoWebUrl).toBe('https://github.com/o/r');
		const nonGithub = sessionOverview({ ...session, repoUrl: 'https://gitlab.com/o/r.git' }, userId);
		expect(nonGithub.environment.repoWebUrl).toBeNull();
		const sensitiveUrl = 'https://github.com/o/r?access_token=secret';
		const sensitive = sessionOverview({ ...session, repoUrl: sensitiveUrl }, userId);
		expect(sensitive.environment.repoWebUrl).toBeNull();
		const serialised = JSON.stringify(sensitive);
		expect(serialised).not.toContain('secret');
		expect(serialised).not.toContain(sensitiveUrl);
	});

	it('returns enabled coding connectors with allowed tool counts and no server URLs', () => {
		const { userId, session } = fixture();
		const suffix = randomUUID();
		const addServer = (name: string, tasks: string[], enabled = true) => {
			const id = `server-${suffix}-${name}`;
			db.insert(mcpServers)
				.values({
					id,
					name: `${name}-${suffix}`,
					transport: 'http',
					url: `https://${name}.example.invalid/${suffix}`,
					headersEnc: null,
					command: null,
					envEnc: null,
					args: null,
					toolPrefix: `${name}_${suffix}`,
					tasks,
					enabled,
					status: 'ok',
					lastError: null,
					lastSyncAt: null,
					createdAt: new Date()
				})
				.run();
			return id;
		};
		const addTool = (serverId: string, name: string) => {
			db.insert(mcpTools)
				.values({
					id: `${serverId}:${name}`,
					serverId,
					name: `${serverId.replaceAll('-', '_')}__${name}`,
					remoteName: name,
					description: '',
					parameters: {}
				})
				.run();
		};
		const offered = addServer('offered', ['coding']);
		const excluded = addServer('excluded', ['chat']);
		const disabledServer = addServer('disabled', ['coding'], false);
		const allDisabled = addServer('all-disabled', ['coding']);
		const disabledName = `${offered.replaceAll('-', '_')}__disabled`;
		addTool(offered, 'allowed');
		addTool(offered, 'disabled');
		addTool(excluded, 'excluded-tool');
		addTool(disabledServer, 'hidden-tool');
		addTool(allDisabled, 'turned-off');
		const disable = (name: string) =>
			db.insert(toolSettings)
				.values({ name, enabled: false, descriptionOverride: null, tasks: null, updatedAt: new Date() })
				.run();
		disable(disabledName);
		disable(`${allDisabled.replaceAll('-', '_')}__turned-off`);

		const overview = sessionOverview(session, userId);
		expect(overview.connectors).toEqual([{ name: `offered-${suffix}`, tools: 1 }]);
		const serialised = JSON.stringify(overview.connectors);
		expect(serialised).not.toContain(`https://offered.example.invalid/${suffix}`);
	});

	it('returns goal, plan, files, checks, and stored commit lines', () => {
		const { chatId, userId, session } = fixture();
		setPlan(chatId, [{ text: 'Add tests', status: 'doing' }, { text: 'Review', status: 'todo' }], 'Ship overview');
		recordChecks(chatId, 'pre_commit', {
			runs: [{ command: 'npm test', code: 0, durationMs: 120 }]
		});
		const state = loadState(chatId);
		setSetting(
			'coding-state',
			{
				...state,
				filesRead: [],
				filesChanged: ['src/a.ts', 'src/b.ts'],
				status: '',
				commits: 'abc first\ndef second\npartial',
				diffStat: '',
				totals: { commits: 4, files: 2, insertions: 4, deletions: 1, uncommitted: 0, at: 42 },
				updatedAt: 42
			},
			chatId
		);

		const overview = sessionOverview(session, userId);
		expect(overview.goal).toBe('Ship overview');
		expect(overview.plan).toEqual([
			{ text: 'Add tests', status: 'doing' },
			{ text: 'Review', status: 'todo' }
		]);
		expect(overview.filesChanged).toEqual(['src/a.ts', 'src/b.ts']);
		expect(overview.changes.commits).toEqual(['abc first', 'def second', 'partial']);
		expect(overview.checks).toMatchObject([
			{ stage: 'pre_commit', runs: [{ command: 'npm test', code: 0, durationMs: 120 }] }
		]);
	});
});
