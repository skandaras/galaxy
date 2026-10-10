<script lang="ts">
	import { ask } from '$lib/confirm.svelte';
	import { ENTITY_KINDS, KINDS } from '$lib/profile-taxonomy';
	import { briefUsage, entryMarks, pathOptions } from '$lib/profile-view';
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

	let draft = $state({ path: '', kind: 'fact', claim: '', pinned: false, until: '' });
	let person = $state({ name: '', kind: 'person', relation: '' });
	let newSub = $state({ domain: 'interests', name: '' });

	const usage = $derived(view ? briefUsage(view.briefUsed, view.limits.briefChars) : null);
	const blank = $derived(!!view && view.count === 0 && view.entities.length === 0);
	const paths = $derived(view ? pathOptions(view.domains) : []);

	async function load() {
		const [res, agents] = await Promise.all([
			fetch('/api/profile').catch(() => null),
			fetch('/api/profile/agents').catch(() => null)
		]);
		if (!res?.ok) {
			loadFailed = true;
			return;
		}
		loadFailed = false;
		view = await res.json();
		blocks = agents?.ok ? (await agents.json()).blocks : [];
		if (!draft.path && paths.length) draft.path = paths[0].value;
	}
	$effect(() => {
		void load();
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
					What you have told Galaxy about yourself and your world. Every agent gets the pinned brief
					and a map of the rest, and looks up the rest only when it would change an answer. Agents
					note things here when you tell them, in your own words; you can undo a note from the reply
					or change it here. The coding agent sees only your tools and expertise. Private entries
					reach only a chat agent, and only when it looks them up.
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
					<label class="chk"><input type="checkbox" bind:checked={draft.pinned} /> pin to the brief</label>
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
													send(e.id, `/api/profile/entries/${e.id}`, 'PATCH', { pinned: !e.pinned }, e.pinned ? 'Unpinned.' : 'Pinned.')}
											>
												{e.pinned ? 'Unpin' : 'Pin'}
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
