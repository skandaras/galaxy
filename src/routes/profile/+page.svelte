<script lang="ts">
	import SkillPatchDiff from '$lib/components/SkillPatchDiff.svelte';
	import type { DiffLine } from '$lib/skill-patch';
	import { ask } from '$lib/confirm.svelte';
	import { ENTITY_KINDS, KINDS } from '$lib/profile-taxonomy';
	import {
		briefUsage,
		entryMarks,
		pathOptions,
		placeLabel,
		learnedWords,
		readingText,
		type LearnedAction,
		type ReadingView
	} from '$lib/profile-view';
	import { stepFor } from '$lib/survey';

	interface Entry {
		id: string;
		claim: string;
		kind: string;
		pinned: boolean;
		sensitivity: 'normal' | 'personal' | 'private';
		source: string;
		expiresAt: string | null;
	}
	interface Subdomain {
		name: string;
		label: string;
		custom: boolean;
		entries: Entry[];
	}
	interface Entity {
		id: string;
		kind: string;
		name: string;
		relation: string;
	}
	interface View {
		domains: { domain: string; subdomains: Subdomain[] }[];
		entities: Entity[];
		count: number;
		briefUsed: number;
		limits: { briefChars: number; claimMax: number };
	}

	interface Learned {
		id: string;
		action: LearnedAction;
		quote: string | null;
		why: string;
		decidedAt: string | null;
		entry: { id: string; claim: string; place: string } | null;
		was: string | null;
	}
	interface Candidate {
		id: string;
		name: string;
		description: string;
		rationale: string;
		tasks: string;
		body: string;
		status: 'pending' | 'approved' | 'rejected';
		kind: 'new' | 'patch';
		preview:
			| {
					kind: 'patch';
					applies: true;
					diff: DiffLine[];
					drifted: boolean;
					fields: {
						description?: { from: string; to: string };
						triggers?: { from: string; to: string };
					};
			  }
			| { kind: 'patch'; applies: false; problem: string }
			| { kind: 'new'; savesAs: string }
			| null;
	}
	interface Learning {
		learned: Learned[];
		candidates: Candidate[];
		enabled: boolean;
		scheduleEnabled: boolean;
		lastRun: number;
		nextDue: number;
		reading: ReadingView | null;
	}

	const TASK_LABEL: Record<string, string> = {
		chat: 'Chat',
		coding: 'Coding',
		'deep-research': 'Deep research'
	};

	let view = $state<View | null>(null);
	let blocks = $state<{ task: string; block: string }[]>([]);
	let loadFailed = $state(false);
	/** Said beside the control that was used, keyed by what it was about. */
	let notice = $state<{ at: string; text: string; error?: boolean } | null>(null);
	let editing = $state<{ id: string; claim: string } | null>(null);
	let versions = $state<{ id: string; list: { claim: string; status: string }[] } | null>(null);
	let learning = $state<Learning | null>(null);
	let busy = $state<'look' | 'read' | null>(null);

	let draft = $state({ path: '', kind: 'fact', claim: '', pinned: false, until: '' });
	let person = $state({ name: '', kind: 'person', relation: '' });
	let newSub = $state({ domain: 'interests', name: '' });

	const usage = $derived(view ? briefUsage(view.briefUsed, view.limits.briefChars) : null);
	const blank = $derived(!!view && view.count === 0 && view.entities.length === 0);
	const paths = $derived(view ? pathOptions(view.domains) : []);
	const skillsWaiting = $derived(learning?.candidates.filter((c) => c.status === 'pending') ?? []);
	const reading = $derived(readingText(learning?.reading ?? null));

	async function load() {
		const [res, agents, learnt] = await Promise.all([
			fetch('/api/profile').catch(() => null),
			fetch('/api/profile/agents').catch(() => null),
			fetch('/api/profile/learning').catch(() => null)
		]);
		if (!res?.ok) {
			loadFailed = true;
			return;
		}
		loadFailed = false;
		view = await res.json();
		blocks = agents?.ok ? (await agents.json()).blocks : [];
		learning = learnt?.ok ? await learnt.json() : null;
		if (!draft.path && paths.length) draft.path = paths[0].value;
	}
	$effect(() => {
		void load();
	});
	// While past conversations are read in the background, follow along: the
	// queue fills as each batch is read.
	$effect(() => {
		if (!learning?.reading?.running) return;
		const timer = setInterval(() => void load(), 3000);
		return () => clearInterval(timer);
	});

	/** Send a change and say what the server said about it, beside `at`. */
	async function send(at: string, url: string, method: string, body?: unknown, done?: string) {
		const res = await fetch(url, {
			method,
			headers: { 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body)
		}).catch(() => null);
		if (!res?.ok) {
			const reason = (await res?.json().catch(() => null))?.message;
			notice = { at, text: reason ?? 'That did not save.', error: true };
			return false;
		}
		notice = done ? { at, text: done } : null;
		await load();
		return true;
	}

	async function undo(p: Learned) {
		// Gone or refused, the list may have moved under it.
		if (!(await send(p.id, `/api/profile/proposals/${p.id}`, 'DELETE', undefined, learnedWords(p.action).done))) await load();
	}

	async function decideSkill(c: Candidate, approve: boolean) {
		await send(
			c.id,
			`/api/skills/candidates/${c.id}`,
			'POST',
			{ approve },
			approve
				? c.kind === 'patch'
					? `${c.name} is updated.`
					: `${c.preview?.kind === 'new' ? c.preview.savesAs : c.name} is now one of your skills.`
				: `${c.name} turned down.`
		);
	}

	async function toggleLearning() {
		if (!learning) return;
		await send('learning', '/api/profile/learning', 'PUT', { enabled: !learning.enabled });
	}

	async function lookNow() {
		busy = 'look';
		notice = null;
		const res = await fetch('/api/profile/learning/run', { method: 'POST' }).catch(() => null);
		busy = null;
		const result = res?.ok ? await res.json() : null;
		if (!result) {
			notice = { at: 'learning', text: 'That did not run. Try again.', error: true };
			return;
		}
		const n = result.learned ?? 0;
		notice = {
			at: 'learning',
			text: result.ran
				? n
					? `Learned ${n} ${n === 1 ? 'thing' : 'things'}, listed above.`
					: 'Nothing new worth adding.'
				: `Nothing to do: ${result.reason}.`
		};
		await load();
	}

	async function readPast() {
		busy = 'read';
		await send('learning', '/api/profile/learning/read', 'POST', undefined, 'Reading your past conversations.');
		busy = null;
	}

	const when = (ts: number) => (ts ? new Date(ts).toLocaleString() : 'never');

	async function add() {
		const ok = await send('add', '/api/profile/entries', 'POST', draft, 'Added.');
		if (ok) draft = { ...draft, claim: '', pinned: false, until: '' };
	}

	async function saveEdit() {
		if (!editing) return;
		const { id, claim } = editing;
		if (await send(id, `/api/profile/entries/${id}`, 'PATCH', { claim }, 'Saved; the old wording is in its history.')) {
			editing = null;
		}
	}

	async function remove(e: Entry) {
		if (
			!(await ask({
				title: `Forget "${e.claim}"?`,
				body: 'It goes with every earlier version of it, and no agent sees it again.',
				confirm: 'Forget it',
				danger: true
			}))
		)
			return;
		await send(e.id, `/api/profile/entries/${e.id}`, 'DELETE', undefined, 'Forgotten.');
	}

	async function showHistory(e: Entry) {
		if (versions?.id === e.id) {
			versions = null;
			return;
		}
		const res = await fetch(`/api/profile/entries/${e.id}/history`).catch(() => null);
		if (!res?.ok) {
			notice = { at: e.id, text: 'Its history did not load.', error: true };
			return;
		}
		versions = { id: e.id, list: (await res.json()).versions };
	}

	async function addPerson() {
		const ok = await send('people', '/api/profile/entities', 'POST', person, `Added ${person.name}.`);
		if (ok) person = { name: '', kind: 'person', relation: '' };
	}

	async function removePerson(p: Entity) {
		if (
			!(await ask({
				title: `Remove ${p.name}?`,
				body: 'Their card goes with them. Anything filed elsewhere that mentions them stays.',
				confirm: `Remove ${p.name}`,
				danger: true
			}))
		)
			return;
		await send('people', `/api/profile/entities/${p.id}`, 'DELETE', undefined, `Removed ${p.name}.`);
	}

	async function addSub() {
		const ok = await send('sub', '/api/profile/subdomains', 'POST', newSub, 'Added.');
		if (ok) newSub = { ...newSub, name: '' };
	}

	async function wipe() {
		if (
			!(await ask({
				title: 'Wipe your whole profile?',
				body: 'Every entry, every person and every subdomain of your own is deleted, with its history.',
				confirm: 'Wipe profile',
				danger: true
			}))
		)
			return;
		await send('top', '/api/profile', 'DELETE', undefined, 'Your profile is empty.');
	}
</script>

{#snippet askAbout(domain: string)}
	{@const step = stepFor(domain)}
	{#if step}<a class="ask-link" href="/profile/survey?step={step}">Answer the questions about this</a>{/if}
{/snippet}

{#snippet fieldChanges(fields: { description?: { from: string; to: string }; triggers?: { from: string; to: string } })}
	{#if fields.description}
		<p class="hint">Description: “{fields.description.from}” becomes “{fields.description.to}”</p>
	{/if}
	{#if fields.triggers}
		<p class="hint">Triggers: “{fields.triggers.from || 'none'}” become “{fields.triggers.to}”</p>
	{/if}
{/snippet}

{#snippet said(at: string)}
	{#if notice?.at === at}
		<p class="notice" class:error={notice.error} role={notice.error ? 'alert' : 'status'}>
			{notice.text}
		</p>
	{/if}
{/snippet}

<div class="profile-page">
	<h1>Profile</h1>
	<section class="profile-section">
		{#if loadFailed}<p class="notice error" role="alert">Your profile did not load.</p>{/if}

		{#if view}
			{#if blank}
				<article class="card">
					<h3>Start your profile</h3>
					<p class="hint">
						A few questions about you, your work, the people in your life and what is on your plate,
						in about eight minutes. Skip anything. Nothing is saved until you have read it through.
					</p>
					<div class="row">
						<a class="btn primary" href="/profile/survey">Answer a few questions</a>
						<a class="btn" href="/profile/import">Import what you have</a>
					</div>
				</article>
			{/if}
			<article class="card">
				<h3>Your profile</h3>
				<p class="hint">
					What Galaxy knows about you and your world. Every agent gets a short brief and a map of
					the rest, and looks up the rest only when it would change an answer. The brief fills
					itself with what matters most, and anything you mark "always" is in it first. Agents note
					things here when you tell them, and Galaxy learns more from your conversations; either
					can be undone. The coding agent sees only your tools, your expertise and how you like to
					be answered. Private entries reach only a chat agent, and only when it looks them up.
				</p>
				<div class="row">
					<span class="meta">{view.count} {view.count === 1 ? 'entry' : 'entries'}</span>
					{#if usage}
						<span class="meta">{usage.text}</span>
						<meter min="0" max="1" value={usage.full} aria-label="How full the brief is"></meter>
					{/if}
					{#if !blank}
						<a class="btn" href="/profile/survey">Questions</a>
						<a class="btn" href="/profile/import">Import</a>
					{/if}
					<a class="btn" href="/api/profile/export" download>Export</a>
					<button class="btn danger" onclick={wipe}>Wipe</button>
				</div>
				{@render said('top')}
			</article>

			{#if learning}
				<article class="card" class:waiting={skillsWaiting.length > 0}>
					<h3>Recently learned</h3>
					{#each learning.learned as p (p.id)}
						{@const words = learnedWords(p.action)}
						<div class="proposal">
							<div class="row">
								<span class="badge">{words.badge}</span>
								<span class="meta">
									{p.entry ? placeLabel(p.entry.place) : ''}
									{#if p.decidedAt} · {when(new Date(p.decidedAt).getTime())}{/if}
								</span>
							</div>
							<div class="claim">{p.entry?.claim}</div>
							{#if p.was}<div class="was">was: {p.was}</div>{/if}
							{#if p.quote}<p class="quote">You said: “{p.quote}”</p>{/if}
							{#if p.why}<p class="hint why">{p.why}</p>{/if}
							<div class="row actions">
								<button class="btn" onclick={() => undo(p)}>{words.undo}</button>
							</div>
							{@render said(p.id)}
						</div>
					{/each}
					{#if skillsWaiting.length}<h4>Skills waiting for you</h4>{/if}
					{#each skillsWaiting as c (c.id)}
						<div class="proposal" data-skill-candidate={c.kind}>
							<div class="row">
								<span class="badge">{c.kind === 'patch' ? 'Skill change' : 'Skill'}</span>
								<strong>{c.name}</strong>
								<span class="meta">{c.description}</span>
							</div>
							{#if c.rationale}<p class="hint why">{c.rationale}</p>{/if}
							{#if c.kind === 'patch' && c.preview?.kind === 'patch'}
								{#if c.preview.applies}
									{#if c.preview.drifted}
										<p class="hint">The skill has changed since this was proposed; this is the change against it as it is now.</p>
									{/if}
									<SkillPatchDiff lines={c.preview.diff} />
									{@render fieldChanges(c.preview.fields)}
									<div class="row actions">
										<button class="btn primary" onclick={() => decideSkill(c, true)}>Apply change</button>
										<button class="btn" onclick={() => decideSkill(c, false)}>Reject</button>
									</div>
								{:else}
									<p class="notice error">This change no longer fits the skill: {c.preview.problem}</p>
									<div class="row actions">
										<button class="btn" onclick={() => decideSkill(c, false)}>Reject</button>
									</div>
								{/if}
							{:else}
								{#if c.preview?.kind === 'new'}
									<p class="hint">Another skill has this name now, so it would be saved as {c.preview.savesAs}.</p>
								{/if}
								<details>
									<summary>The instructions{c.tasks ? ` (for ${c.tasks})` : ''}</summary>
									<pre class="block">{c.body}</pre>
								</details>
								<div class="row actions">
									<button class="btn primary" onclick={() => decideSkill(c, true)}>Approve skill</button>
									<button class="btn" onclick={() => decideSkill(c, false)}>Reject</button>
								</div>
							{/if}
							{@render said(c.id)}
						</div>
					{/each}
					{#if !learning.learned.length && !skillsWaiting.length}
						<p class="hint">
							Nothing yet. Galaxy reads your new conversations for things about you and your world
							and adds the few that will matter later. Each one is listed here with the words it
							came from, and undoing one means it is not learned again.
						</p>
					{/if}
					<div class="row learn">
						<label class="chk">
							<input type="checkbox" checked={learning.enabled} onchange={toggleLearning} />
							learn from my conversations
						</label>
						<button class="btn" disabled={busy !== null || learning.reading?.running} onclick={lookNow}>
							{busy === 'look' ? 'Looking…' : 'Look now'}
						</button>
						<button class="btn" disabled={busy !== null || learning.reading?.running} onclick={readPast}>
							{busy === 'read' ? 'Starting…' : 'Read my past conversations'}
						</button>
						<span class="meta">
							last looked {when(learning.lastRun)}
							{#if learning.enabled && learning.scheduleEnabled && learning.lastRun} · next {when(learning.nextDue)}{/if}
							{#if !learning.scheduleEnabled} · automatic learning is off for everyone{/if}
						</span>
					</div>
					{#if reading}
						<p class="notice" class:error={reading.error} role={reading.error ? 'alert' : 'status'}>
							{reading.text}
						</p>
					{/if}
					{@render said('learning')}
				</article>
			{/if}

			<article class="card">
				<h3>Add something</h3>
				<div class="form">
					<label>
						Where
						<select bind:value={draft.path}>
							{#each paths as p (p.value)}<option value={p.value}>{p.label}</option>{/each}
						</select>
					</label>
					<label>
						Kind
						<select bind:value={draft.kind}>
							{#each KINDS as k (k)}<option value={k}>{k}</option>{/each}
						</select>
					</label>
					<label class="wide">
						What is true
						<input
							bind:value={draft.claim}
							maxlength={view.limits.claimMax}
							placeholder="Vegetarian."
						/>
					</label>
					<label>
						True until (optional)
						<input type="date" bind:value={draft.until} />
					</label>
					<label class="chk"><input type="checkbox" bind:checked={draft.pinned} /> always in the brief</label>
				</div>
				<button class="btn primary" disabled={!draft.claim.trim() || !draft.path} onclick={add}>Add</button>
				{@render said('add')}
			</article>

			{#each view.domains as d (d.domain)}
				{@const filled = d.subdomains.filter((s) => s.entries.length)}
				{#if d.domain === 'people'}
					<article class="card">
						<h3>People and things</h3>
						{@render askAbout('people')}
						<ul class="entities">
							{#each view.entities as p (p.id)}
								<li>
									<strong>{p.name}</strong>
									<span class="meta">{p.kind}{p.relation ? `, ${p.relation}` : ''}</span>
									<button class="btn ghost" onclick={() => removePerson(p)}>Remove</button>
								</li>
							{:else}
								<li class="hint">No one yet.</li>
							{/each}
						</ul>
						<div class="form">
							<label>Name <input bind:value={person.name} maxlength="40" /></label>
							<label>
								Is a
								<select bind:value={person.kind}>
									{#each ENTITY_KINDS as k (k)}<option value={k}>{k}</option>{/each}
								</select>
							</label>
							<label>To you <input bind:value={person.relation} maxlength="32" placeholder="sister" /></label>
						</div>
						<button class="btn" disabled={!person.name.trim()} onclick={addPerson}>Add</button>
						{@render said('people')}
					</article>
				{/if}
				{#if filled.length}
					<article class="card">
						<h3>{d.domain}</h3>
						{@render askAbout(d.domain)}
						{#each filled as s (s.name)}
							<h4>{s.label}</h4>
							<ul class="entries">
								{#each s.entries as e (e.id)}
									<li>
										{#if editing?.id === e.id}
											<input class="claim-edit" bind:value={editing.claim} maxlength={view.limits.claimMax} />
											<div class="row">
												<button class="btn primary" onclick={saveEdit}>Save</button>
												<button class="btn" onclick={() => (editing = null)}>Cancel</button>
											</div>
										{:else}
											<span class="claim">{e.claim}</span>
											{#each entryMarks(e) as m (m)}<span class="badge">{m}</span>{/each}
										{/if}
										<div class="row actions">
											<button
												class="btn ghost"
												disabled={e.sensitivity === 'private'}
												onclick={() =>
													send(e.id, `/api/profile/entries/${e.id}`, 'PATCH', { pinned: !e.pinned }, e.pinned ? 'Back to automatic.' : 'Always in the brief now.')}
											>
												{e.pinned ? 'Automatic' : 'Always in brief'}
											</button>
											<select
												aria-label="Who may see it"
												value={e.sensitivity}
												onchange={(ev) =>
													send(e.id, `/api/profile/entries/${e.id}`, 'PATCH', { sensitivity: ev.currentTarget.value }, 'Saved.')}
											>
												<option value="normal">normal</option>
												<option value="personal">personal</option>
												<option value="private">private</option>
											</select>
											<button class="btn ghost" onclick={() => (editing = { id: e.id, claim: e.claim })}>Edit</button>
											<button class="btn ghost" onclick={() => showHistory(e)}>History</button>
											<button class="btn ghost" onclick={() => remove(e)}>Forget</button>
										</div>
										{#if versions?.id === e.id}
											<ol class="history">
												{#each versions.list as v, i (i)}
													<li class:old={v.status !== 'active'}>{v.claim}</li>
												{/each}
											</ol>
										{/if}
										{@render said(e.id)}
									</li>
								{/each}
							</ul>
						{/each}
					</article>
				{/if}
			{/each}

			<article class="card">
				<h3>A subdomain of your own</h3>
				<p class="hint">Up to four per domain, beside the ones every profile has.</p>
				<div class="form">
					<label>
						In
						<select bind:value={newSub.domain}>
							{#each view.domains.filter((d) => d.domain !== 'people') as d (d.domain)}
								<option value={d.domain}>{d.domain}</option>
							{/each}
						</select>
					</label>
					<label>Name <input bind:value={newSub.name} maxlength="24" placeholder="cooking" /></label>
				</div>
				<button class="btn" disabled={!newSub.name.trim()} onclick={addSub}>Add</button>
				{@render said('sub')}
			</article>

			<article class="card">
				<h3>What agents see</h3>
				<p class="hint">Exactly what each agent is given, every turn.</p>
				{#each blocks as b (b.task)}
					<details>
						<summary>{TASK_LABEL[b.task] ?? b.task} · {b.block.length.toLocaleString('en-NZ')} characters</summary>
						<pre class="block">{b.block || '(nothing)'}</pre>
					</details>
				{/each}
			</article>
		{/if}
	</section>
</div>

<style>
	.profile-page {
		flex: 1;
		min-width: 0;
		padding: 1rem 1.25rem;
		overflow-y: auto;
	}
	h1 {
		margin: 0 0 1rem;
		font-size: var(--text-lg);
		letter-spacing: 0.3em;
		color: var(--heading);
	}
	.profile-section {
		max-width: 46rem;
	}
	@media (max-width: 720px) {
		.profile-page {
			padding: 0.75rem 0.85rem;
		}
	}
	.card {
		margin-bottom: 0.9rem;
	}
	h3 {
		margin: 0 0 0.6rem;
		font-size: var(--text-md);
		letter-spacing: 0.15em;
		text-transform: uppercase;
		color: var(--heading);
	}
	h4 {
		margin: 0.7rem 0 0.2rem;
		font-size: var(--text-base);
		color: var(--fg-dim);
	}
	.hint {
		margin: 0 0 0.7rem;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		flex-wrap: wrap;
	}
	.meta {
		font-size: var(--text-sm);
		color: var(--fg-dim);
	}
	.form {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
		margin-bottom: 0.6rem;
	}
	.form label {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		font-size: var(--text-sm);
		color: var(--fg-dim);
	}
	.form label.wide {
		flex: 1 1 100%;
	}
	.form label.chk {
		flex-direction: row;
		align-items: center;
		gap: 0.4rem;
	}
	.form input:not([type='checkbox']),
	.form select {
		min-width: 10rem;
	}
	.form label.wide input,
	.claim-edit {
		width: 100%;
		box-sizing: border-box;
	}
	ul.entries,
	ul.entities {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	ul.entries > li,
	ul.entities > li {
		border-top: 1px solid var(--border);
		padding: 0.45rem 0;
		font-size: var(--text-base);
	}
	ul.entities > li {
		display: flex;
		align-items: baseline;
		gap: 0.6rem;
	}
	.claim {
		margin-right: 0.4rem;
	}
	.badge {
		margin-right: 0.3rem;
	}
	.actions {
		margin-top: 0.3rem;
	}
	.history {
		margin: 0.3rem 0 0;
		padding-left: 1.2rem;
		font-size: var(--text-sm);
	}
	.history .old {
		color: var(--fg-dim);
		text-decoration: line-through;
	}
	details summary {
		font-size: var(--text-base);
		color: var(--fg-dim);
		cursor: pointer;
		margin-top: 0.4rem;
	}
	.block {
		white-space: pre-wrap;
		font-family: var(--font-mono);
		font-size: var(--text-sm);
		color: var(--fg-dim);
		margin: 0.4rem 0 0;
	}
	meter {
		width: 8rem;
	}
	.card.waiting {
		border-color: var(--accent);
	}
	.proposal {
		border-top: 1px solid var(--border);
		padding: 0.55rem 0;
	}
	.proposal .claim {
		display: block;
		margin: 0.3rem 0 0;
	}
	.was {
		font-size: var(--text-sm);
		color: var(--fg-dim);
		text-decoration: line-through;
	}
	.quote {
		margin: 0.3rem 0 0;
		font-size: var(--text-sm);
		color: var(--fg-dim);
		font-style: italic;
	}
	.why {
		margin: 0.2rem 0 0;
	}
	.chk {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: var(--text-base);
		color: var(--fg-dim);
	}
	.learn {
		border-top: 1px solid var(--border);
		padding-top: 0.6rem;
		margin-top: 0.4rem;
	}
	.ask-link {
		display: inline-block;
		margin-bottom: 0.4rem;
		font-size: var(--text-sm);
		color: var(--fg-dim);
	}
	input:not([type='checkbox']):not([type='file']),
	select {
		background: var(--bg-pane);
		border: 1px solid var(--control-border);
		color: var(--fg);
		font-family: inherit;
		padding: 0.3rem 0.45rem;
		box-sizing: border-box;
	}
</style>
