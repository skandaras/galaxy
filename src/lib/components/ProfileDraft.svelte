<script lang="ts">
	import {
		draftPaths,
		draftProblems,
		pathSensitivity,
		type Draft,
		type DraftPath,
		type ViewDomain
	} from '$lib/profile-draft';
	import { ENTITY_KINDS, KINDS } from '$lib/profile-taxonomy';

	/**
	 * A draft, line by line, before any of it is saved: the review step the
	 * survey and every import share. Saving is all or nothing, so a refusal comes
	 * back against its line and the person fixes that one and saves again.
	 */

	interface Refusal {
		at: 'person' | 'entry';
		index: number;
		message: string;
	}

	interface Props {
		draft: Draft;
		/** For the places a line can go. */
		domains: ViewDomain[];
		source: 'survey' | 'imported';
		onsaved: (result: { added: number; skipped: number; people: number }) => void;
	}

	let { draft = $bindable(), domains, source, onsaved }: Props = $props();

	let refusals = $state<Refusal[]>([]);
	let saving = $state(false);
	let notice = $state<string | null>(null);

	const today = new Date().toISOString().slice(0, 10);
	const problems = $derived(draftProblems(draft, today));
	const places = $derived(draftPaths(domains, draft));
	const blocked = $derived(
		problems.entries.some(Boolean) || problems.people.some(Boolean) || saving
	);
	const empty = $derived(!draft.entries.length && !draft.people.length);
	const saveLabel = $derived(
		'Save ' +
			[
				draft.entries.length ? `${draft.entries.length} ${draft.entries.length === 1 ? 'line' : 'lines'}` : '',
				draft.people.length ? `${draft.people.length} ${draft.people.length === 1 ? 'name' : 'names'}` : ''
			]
				.filter(Boolean)
				.join(' and ')
	);

	const placeOf = (path: string): DraftPath | undefined =>
		places.find((p) => p.value.toLowerCase() === path.toLowerCase());
	const privacyOf = (e: Draft['entries'][number]) =>
		e.sensitivity ?? placeOf(e.path)?.sensitivity ?? pathSensitivity(e.path);
	const refusal = (at: Refusal['at'], index: number) =>
		refusals.find((r) => r.at === at && r.index === index)?.message ?? null;

	/** Positions move when a line goes, so what the server said about them no longer lines up. */
	function changed() {
		refusals = [];
		notice = null;
	}

	function removeEntry(i: number) {
		draft.entries.splice(i, 1);
		changed();
	}

	/** Someone's card and anything said to be about them follow their name. */
	function renamePerson(i: number, name: string) {
		const old = draft.people[i].name;
		draft.people[i].name = name;
		for (const e of draft.entries) {
			if (e.path.toLowerCase() === `people/${old}`.toLowerCase()) e.path = `people/${name}`;
			if (e.about?.toLowerCase() === old.toLowerCase()) e.about = name;
		}
		changed();
	}

	function removePerson(i: number) {
		const name = draft.people[i].name.toLowerCase();
		draft.people.splice(i, 1);
		draft.entries = draft.entries.filter((e) => e.path.toLowerCase() !== `people/${name}`);
		for (const e of draft.entries) if (e.about?.toLowerCase() === name) e.about = null;
		changed();
	}

	async function save() {
		saving = true;
		notice = null;
		const res = await fetch('/api/profile/confirm', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ draft, source })
		}).catch(() => null);
		saving = false;
		const body = await res?.json().catch(() => null);
		if (!res?.ok) {
			refusals = body?.refusals ?? [];
			notice = body?.message ?? 'Nothing was saved. Try again.';
			return;
		}
		onsaved(body);
	}
</script>

<div class="draft">
	{#each draft.leftOut as note, i (i)}<p class="hint">{note}</p>{/each}

	{#if draft.people.length}
		<h4>People and things</h4>
		<ul class="lines">
			{#each draft.people as p, i (i)}
				<li>
					<div class="fields">
						<label>
							Name
							<input value={p.name} maxlength="40" oninput={(ev) => renamePerson(i, ev.currentTarget.value)} />
						</label>
						<label>
							Is a
							<select bind:value={p.kind} onchange={changed}>
								{#each ENTITY_KINDS as k (k)}<option value={k}>{k}</option>{/each}
							</select>
						</label>
						<label>To you <input bind:value={p.relation} maxlength="32" oninput={changed} /></label>
						<button class="btn ghost" onclick={() => removePerson(i)}>Leave out</button>
					</div>
					{#if problems.people[i] ?? refusal('person', i)}
						<p class="notice error">{problems.people[i] ?? refusal('person', i)}</p>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}

	{#if draft.entries.length}
		<h4>What goes in</h4>
		<ul class="lines">
			{#each draft.entries as e, i (i)}
				{@const isPrivate = privacyOf(e) === 'private'}
				<li>
					<input class="claim" aria-label="What is true" bind:value={e.claim} oninput={changed} />
					<div class="fields">
						<label>
							Where
							<select
								value={e.path}
								onchange={(ev) => {
									e.path = ev.currentTarget.value;
									// The old path's privacy goes with the old path: an entry moved
									// into health takes health's, rather than staying as it was.
									e.sensitivity = null;
									if (privacyOf(e) === 'private') e.pinned = false;
									changed();
								}}
							>
								{#if !placeOf(e.path)}<option value={e.path}>{e.path || 'choose'}</option>{/if}
								{#each places as p (p.value)}
									<option value={p.value}>{p.label}{p.isNew ? ' (new)' : ''}</option>
								{/each}
							</select>
						</label>
						<label>
							Kind
							<select bind:value={e.kind} onchange={changed}>
								{#each KINDS as k (k)}<option value={k}>{k}</option>{/each}
							</select>
						</label>
						<label>
							True until
							<input
								type="date"
								value={e.until ?? ''}
								onchange={(ev) => {
									e.until = ev.currentTarget.value || null;
									changed();
								}}
							/>
						</label>
						<label class="chk">
							<input type="checkbox" bind:checked={e.pinned} disabled={isPrivate} onchange={changed} /> pin
						</label>
						<button class="btn ghost" onclick={() => removeEntry(i)}>Leave out</button>
					</div>
					<div class="marks">
						{#if isPrivate}<span class="badge">private</span>{/if}
						{#if placeOf(e.path)?.isNew}<span class="badge">new place</span>{/if}
						{#if e.about}<span class="meta">about {e.about}</span>{/if}
					</div>
					{#if problems.entries[i] ?? refusal('entry', i)}
						<p class="notice error">{problems.entries[i] ?? refusal('entry', i)}</p>
					{/if}
				</li>
			{/each}
		</ul>
	{:else}
		<p class="hint">Nothing to add from this.</p>
	{/if}

	{#if draft.notCarried.length}
		<h4>Not carried over</h4>
		<p class="hint">
			These say how an assistant should reply, which is a setting rather than something about you,
			so they stay out of your profile. Copy any you want to keep.
		</p>
		<ul class="carried">
			{#each draft.notCarried as line, i (i)}<li>{line}</li>{/each}
		</ul>
	{/if}

	<div class="row">
		<button class="btn primary" disabled={blocked || empty} onclick={save}>
			{saving ? 'Saving…' : saveLabel}
		</button>
		<span class="meta">Nothing is saved until you do.</span>
	</div>
	{#if notice}<p class="notice error" role="alert">{notice}</p>{/if}
</div>

<style>
	h4 {
		margin: 0.9rem 0 0.3rem;
		font-size: var(--text-base);
		color: var(--fg-dim);
	}
	.lines,
	.carried {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.lines > li {
		border-top: 1px solid var(--border);
		padding: 0.55rem 0;
	}
	.carried > li {
		font-size: var(--text-base);
		padding: 0.2rem 0;
	}
	.claim {
		width: 100%;
		box-sizing: border-box;
		margin-bottom: 0.4rem;
	}
	.fields {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 0.5rem;
	}
	.fields label {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		font-size: var(--text-sm);
		color: var(--fg-dim);
	}
	.fields label.chk {
		flex-direction: row;
		align-items: center;
		gap: 0.3rem;
		min-height: var(--tap);
	}
	.marks {
		display: flex;
		gap: 0.4rem;
		align-items: baseline;
		margin-top: 0.3rem;
	}
	.meta {
		font-size: var(--text-sm);
		color: var(--fg-dim);
	}
	.row {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		flex-wrap: wrap;
		margin-top: 0.9rem;
	}
	.notice {
		margin: 0.3rem 0 0;
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
