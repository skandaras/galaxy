<script lang="ts">
	import { goto } from '$app/navigation';
	import {
		PRIORITIES,
		PRIORITY_LABEL,
		type Card,
		type CardAttachment,
		type CardLogEntry,
		type Lane,
		type Member,
		type Project,
		type Status
	} from '$lib/board-types';

	interface Props {
		cardId: string;
		lanes: Lane[];
		statuses: Status[];
		projects: Project[];
		members: Member[];
		onclose: () => void;
		/** Fired after any change, so the board behind can refresh. */
		onchanged: () => void;
	}
	let { cardId, lanes, statuses, projects, members, onclose, onchanged }: Props = $props();

	let card = $state<Card | null>(null);
	let log = $state<CardLogEntry[]>([]);
	let attachments = $state<CardAttachment[]>([]);
	let title = $state('');
	let description = $state('');
	let comment = $state('');
	let uploadError = $state<string | null>(null);
	let busy = $state(false);
	let handoffError = $state<string | null>(null);

	// Reloads whenever the drawer is pointed at a different card.
	$effect(() => {
		void load(cardId);
	});

	async function load(id: string) {
		const res = await fetch(`/api/cards/${id}`);
		if (!res.ok) return onclose();
		const detail = await res.json();
		card = detail.card;
		log = detail.log;
		attachments = detail.attachments;
		title = detail.card.title;
		description = detail.card.description;
	}

	async function patch(body: Record<string, unknown>) {
		busy = true;
		const res = await fetch(`/api/cards/${cardId}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		busy = false;
		if (res.ok) {
			await load(cardId);
			onchanged();
		}
	}

	const saveText = () => patch({ title, description });

	async function addComment() {
		const detail = comment.trim();
		if (!detail) return;
		comment = '';
		await fetch(`/api/cards/${cardId}/log`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ detail })
		});
		await load(cardId);
	}

	async function upload(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		uploadError = null;
		const form = new FormData();
		form.append('file', file);
		const res = await fetch(`/api/cards/${cardId}/attachments`, { method: 'POST', body: form });
		// Reset first, so picking the same file again after a failure still fires.
		input.value = '';
		if (!res.ok) {
			uploadError = (await res.json().catch(() => ({}))).message ?? 'Upload failed';
			return;
		}
		await load(cardId);
	}

	async function removeAttachment(id: string) {
		await fetch(`/api/cards/${cardId}/attachments/${id}`, { method: 'DELETE' });
		await load(cardId);
	}

	/**
	 * Hand the card to an agent. The work happens in an ordinary chat — that is
	 * where streaming, recovery and the question drawer already live — so this
	 * navigates rather than running anything inside the board.
	 */
	async function giveToAgent() {
		busy = true;
		handoffError = null;
		const res = await fetch(`/api/cards/${cardId}/agent`, { method: 'POST' });
		busy = false;
		if (!res.ok) {
			handoffError = (await res.json().catch(() => ({}))).message ?? 'Could not start the agent';
			return;
		}
		const { chatId } = await res.json();
		onchanged();
		await goto(`/chat?chat=${chatId}`);
	}

	async function remove() {
		if (!confirm('Delete this card and its log? This cannot be undone.')) return;
		await fetch(`/api/cards/${cardId}`, { method: 'DELETE' });
		onchanged();
		onclose();
	}

	const dirty = $derived(
		!!card && (title !== card.title || description !== card.description)
	);
	const status = $derived(statuses.find((s) => s.id === card?.statusId));
	const nameOf = (id: string | null) =>
		id ? (members.find((m) => m.userId === id)?.username ?? 'someone') : '';
	const when = (ts: number) =>
		new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
</script>

<aside class="detail">
	<header>
		<input class="title" bind:value={title} onblur={saveText} aria-label="Card title" />
		<button class="icon" title="Close" onclick={onclose}>✕</button>
	</header>

	{#if card}
		<div class="scroll">
			<div class="controls">
				<label>
					<span>Status</span>
					<select value={card.statusId} onchange={(e) => patch({ statusId: e.currentTarget.value })}>
						{#each statuses as s (s.id)}
							<option value={s.id}>{s.name}{s.isDone ? ' (archives)' : ''}</option>
						{/each}
					</select>
				</label>
				<label>
					<span>Lane</span>
					<select value={card.laneId} onchange={(e) => patch({ laneId: e.currentTarget.value })}>
						{#each lanes as l (l.id)}
							<option value={l.id}>{l.name}</option>
						{/each}
					</select>
				</label>
				<label>
					<span>Priority</span>
					<select value={card.priority} onchange={(e) => patch({ priority: e.currentTarget.value })}>
						{#each PRIORITIES as p (p)}
							<option value={p}>{PRIORITY_LABEL[p]}</option>
						{/each}
					</select>
				</label>
				<label>
					<span>Project</span>
					<select
						value={card.projectId ?? ''}
						onchange={(e) => patch({ projectId: e.currentTarget.value || null })}
					>
						<option value="">None</option>
						{#each projects as p (p.id)}
							<option value={p.id}>{p.name}</option>
						{/each}
					</select>
				</label>
				<label>
					<span>Assigned</span>
					<select
						value={card.assignedTo ?? ''}
						onchange={(e) => patch({ assignedTo: e.currentTarget.value || null })}
					>
						<option value="">Nobody</option>
						{#each members as m (m.userId)}
							<option value={m.userId}>{m.displayName || m.username}</option>
						{/each}
					</select>
				</label>
			</div>

			{#if card.archivedAt}
				<p class="archived-note">
					Archived {when(card.archivedAt)}{status?.isDone ? ` as ${status.name}` : ''}. Move it to an
					unfinished status to bring it back.
				</p>
			{/if}

			<label class="block">
				<span>Description</span>
				<textarea
					rows="6"
					bind:value={description}
					onblur={saveText}
					placeholder="What needs doing, and anything an agent would need to know to do it."
				></textarea>
			</label>
			{#if dirty}<p class="hint">Unsaved — click away from the field to save.</p>{/if}

			<section class="files">
				<h4>Attachments</h4>
				{#each attachments as a (a.id)}
					<div class="file">
						<a href={`/api/cards/${cardId}/attachments/${a.id}`}>{a.name}</a>
						<span class="meta">{Math.max(1, Math.round(a.size / 1024))} KB</span>
						<button class="icon" title="Remove" onclick={() => removeAttachment(a.id)}>✕</button>
					</div>
				{:else}
					<p class="hint">None yet.</p>
				{/each}
				<label class="upload btn ghost">
					Attach a file
					<input type="file" hidden onchange={upload} />
				</label>
				{#if uploadError}<p class="error">{uploadError}</p>{/if}
			</section>

			<section class="log">
				<h4>Log</h4>
				{#each log as entry (entry.id)}
					<div class="entry" class:agent={entry.actor === 'agent'}>
						<span class="event">{entry.event}</span>
						{#if entry.detail}<span class="entry-detail">{entry.detail}</span>{/if}
						<span class="meta">
							{entry.actor === 'agent' ? 'agent' : nameOf(entry.userId) || 'you'} · {when(
								entry.createdAt
							)}
						</span>
					</div>
				{:else}
					<p class="hint">Nothing yet.</p>
				{/each}
				<div class="comment">
					<input
						placeholder="Add a note…"
						bind:value={comment}
						onkeydown={(e) => e.key === 'Enter' && addComment()}
					/>
					<button class="btn" disabled={!comment.trim()} onclick={addComment}>Add</button>
				</div>
			</section>

			<footer>
				<button class="btn primary" disabled={busy} onclick={giveToAgent}>
					{busy ? 'Starting…' : 'Give to AI'}
				</button>
				<button class="btn danger" disabled={busy} onclick={remove}>Delete card</button>
			</footer>
			{#if handoffError}<p class="error">{handoffError}</p>{/if}
			<p class="hint">
				The agent reads the card, its attachments and its Log first, and asks you before
				guessing at anything it needs.
			</p>
		</div>
	{/if}
</aside>

<style>
	.detail {
		width: 24rem;
		flex-shrink: 0;
		border-left: 1px solid var(--border);
		background: var(--bg-pane);
		display: flex;
		flex-direction: column;
		min-height: 0;
	}
	header {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.6rem 0.7rem;
		border-bottom: 1px solid var(--border);
	}
	.title {
		flex: 1;
		min-width: 0;
		background: transparent;
		border: none;
		border-bottom: 1px solid transparent;
		color: var(--fg);
		font-family: inherit;
		font-size: 0.92rem;
		padding: 0.25rem 0;
		outline: none;
	}
	.title:focus {
		border-bottom-color: var(--accent);
	}
	.scroll {
		flex: 1;
		overflow-y: auto;
		padding: 0.7rem;
	}
	.controls {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.5rem;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		font-size: 0.66rem;
		color: var(--label);
	}
	label.block {
		margin-top: 0.8rem;
	}
	select,
	textarea,
	.comment input {
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 5px;
		color: var(--fg);
		font-family: inherit;
		font-size: 0.76rem;
		padding: 0.3rem 0.4rem;
		width: 100%;
		box-sizing: border-box;
	}
	textarea {
		resize: vertical;
		line-height: 1.5;
	}
	h4 {
		margin: 1rem 0 0.4rem;
		font-size: 0.66rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--heading);
	}
	.file {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.74rem;
		padding: 0.15rem 0;
	}
	.file a {
		color: var(--fg);
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.entry {
		font-size: 0.72rem;
		padding: 0.3rem 0;
		border-bottom: 1px solid var(--border);
	}
	.entry.agent {
		border-left: 2px solid var(--accent);
		padding-left: 0.4rem;
	}
	.event {
		color: var(--accent);
		text-transform: uppercase;
		font-size: 0.6rem;
		letter-spacing: 0.1em;
		margin-right: 0.35rem;
	}
	.entry-detail {
		word-break: break-word;
	}
	.meta {
		display: block;
		color: var(--fg-dim);
		font-size: 0.62rem;
		margin-top: 0.15rem;
	}
	.file .meta {
		display: inline;
		margin: 0;
	}
	.comment {
		display: flex;
		gap: 0.35rem;
		margin-top: 0.5rem;
	}
	.hint,
	.archived-note {
		font-size: 0.68rem;
		color: var(--fg-dim);
		line-height: 1.5;
	}
	.archived-note {
		border-left: 2px solid var(--accent);
		padding-left: 0.5rem;
		margin: 0.7rem 0 0;
	}
	.error {
		color: var(--danger);
		font-size: 0.7rem;
	}
	footer {
		display: flex;
		gap: 0.4rem;
		margin-top: 1.2rem;
		padding-top: 0.6rem;
		border-top: 1px solid var(--border);
	}
	.btn {
		background: var(--border);
		color: var(--fg);
		border: none;
		border-radius: 5px;
		padding: 0.35rem 0.7rem;
		font-family: inherit;
		font-size: 0.74rem;
		cursor: pointer;
	}
	.btn.primary {
		background: var(--accent);
		color: var(--bg);
	}
	.btn.danger {
		background: transparent;
		border: 1px solid var(--danger);
		color: var(--danger);
	}
	.btn.ghost {
		background: transparent;
		border: 1px dashed var(--fg-dim);
		color: var(--fg-dim);
	}
	.upload {
		display: inline-flex;
		align-items: center;
		margin-top: 0.3rem;
	}
	.icon {
		background: none;
		border: none;
		color: var(--fg-dim);
		cursor: pointer;
		/* Big enough to hit with a thumb — these used to be 0.6rem targets. */
		font-size: 0.9rem;
		line-height: 1;
		padding: 0.3rem 0.4rem;
	}
	.icon:hover {
		color: var(--fg);
	}

	@media (max-width: 900px) {
		/* No room for a side-by-side drawer: the card takes the screen. */
		.detail {
			position: fixed;
			inset: 0;
			width: auto;
			z-index: 40;
			border-left: none;
		}
	}
</style>
