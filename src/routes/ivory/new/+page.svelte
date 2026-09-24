<script lang="ts">
	import { goto } from '$app/navigation';

	/** The brief template's sections, in its order, with its own guidance as the hints. */
	const TEXT_FIELDS = [
		{ key: 'question', label: 'Question', required: true, rows: 2, hint: 'One sentence. If it needs two, it is probably two projects.' },
		{ key: 'whyNew', label: 'Why this might be new', required: false, rows: 3, hint: 'What you suspect nobody has connected yet, and why. A hunch is fine; the planner’s first job is to try to disprove it.' },
		{ key: 'scopeIn', label: 'Scope: in', required: false, rows: 2, hint: '' },
		{ key: 'scopeOut', label: 'Scope: out', required: false, rows: 2, hint: '' },
		{ key: 'doneWhen', label: 'Done when', required: true, rows: 3, hint: 'The artefact that ends the project: a mapping claim that reaches survived, a synthesis with testable predictions, or a known verdict showing the idea already exists (still a result).' },
		{ key: 'killCriteria', label: 'Kill criteria', required: true, rows: 3, hint: 'What stops the project early, e.g. “the target field already has this under another name”. The planner checks these first.' },
		{ key: 'startingPoints', label: 'Starting points', required: false, rows: 3, hint: 'Papers, authors, datasets, search terms you already know.' },
		{ key: 'plannerNotes', label: 'Notes for the planner', required: false, rows: 2, hint: 'Budget, deadline, sources to avoid, models to use or avoid.' }
	] as const;

	type Key = 'title' | 'slug' | 'disciplines' | 'validationTier' | (typeof TEXT_FIELDS)[number]['key'];

	let form = $state<Record<Key, string>>({
		title: '',
		slug: '',
		disciplines: '',
		validationTier: 'reading',
		question: '',
		whyNew: '',
		scopeIn: '',
		scopeOut: '',
		doneWhen: '',
		killCriteria: '',
		startingPoints: '',
		plannerNotes: ''
	});
	/** Follows the title until someone edits it by hand. */
	let slugEdited = $state(false);
	let problems = $state<Record<string, string>>({});
	let failure = $state<string | null>(null);
	let busy = $state<'create' | 'plan' | null>(null);
	let known = $state<string[]>([]);

	const suggested = $derived(
		form.title
			.normalize('NFKD')
			.replace(/[̀-ͯ]/g, '')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 64)
			.replace(/-+$/, '')
	);
	$effect(() => {
		if (!slugEdited) form.slug = suggested;
	});

	$effect(() => {
		void (async () => {
			const res = await fetch('/api/ivory/projects');
			const body = await res.json().catch(() => ({}));
			if (!res.ok) failure = body.message ?? `The Shelf could not be read (${res.status})`;
			else if (!body.configured) failure = `No GitHub token is configured, so there is nowhere to create a project. An admin can add one in Admin → Settings → GitHub.`;
			else known = (body.groups ?? []).map((g: { discipline: string }) => g.discipline).filter((d: string) => d !== 'unfiled');
		})();
	});

	async function submit(thenPlan: boolean) {
		busy = thenPlan ? 'plan' : 'create';
		problems = {};
		failure = null;
		const res = await fetch('/api/ivory/projects', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(form)
		});
		const body = await res.json().catch(() => ({}));
		if (!res.ok) {
			busy = null;
			problems = body.problems ?? {};
			failure = body.message ?? `The project was not created (${res.status})`;
			return;
		}
		if (thenPlan) {
			const plan = await fetch(`/api/ivory/projects/${encodeURIComponent(body.slug)}/plan`, { method: 'POST' });
			const started = await plan.json().catch(() => ({}));
			if (plan.ok) {
				await goto(`/chat?chat=${started.chatId}`);
				return;
			}
		}
		await goto(`/ivory/${body.slug}${body.warning ? `?warning=${encodeURIComponent(body.warning)}` : ''}`);
	}
</script>

<div class="ivory-page">
	<header>
		<a class="back" href="/ivory">← Shelf</a>
		<h2>New project</h2>
	</header>

	<form
		onsubmit={(e) => {
			e.preventDefault();
			void submit(false);
		}}
	>
		{#if failure}<p class="notice error" role="alert">{failure}</p>{/if}

		<label>
			<span>Title <em>required</em></span>
			<input bind:value={form.title} maxlength="120" aria-invalid={!!problems.title} />
			{#if problems.title}<small class="problem">{problems.title}</small>{/if}
		</label>

		<label>
			<span>Folder name</span>
			<input
				bind:value={form.slug}
				oninput={() => (slugEdited = true)}
				maxlength="64"
				aria-invalid={!!problems.slug}
			/>
			<small>projects/{form.slug || '…'}/ on the Shelf. Filled in from the title.</small>
			{#if problems.slug}<small class="problem">{problems.slug}</small>{/if}
		</label>

		<div class="pair">
			<label>
				<span>Disciplines <em>required</em></span>
				<input bind:value={form.disciplines} list="ivory-disciplines" placeholder="e.g. marine-biology, aeronautics" aria-invalid={!!problems.disciplines} />
				<datalist id="ivory-disciplines">
					{#each known as d (d)}<option value={d}></option>{/each}
				</datalist>
				<small>Comma-separated. The project is listed under each one.</small>
				{#if problems.disciplines}<small class="problem">{problems.disciplines}</small>{/if}
			</label>
			<label>
				<span>Validation tier</span>
				<select bind:value={form.validationTier}>
					<option value="reading">reading</option>
					<option value="computation">computation</option>
					<option value="lab">lab</option>
				</select>
				<small>The furthest it can get without outside help.</small>
			</label>
		</div>

		{#each TEXT_FIELDS as f (f.key)}
			<label>
				<span>{f.label}{#if f.required} <em>required</em>{/if}</span>
				<textarea bind:value={form[f.key]} rows={f.rows} aria-invalid={!!problems[f.key]}></textarea>
				{#if f.hint}<small>{f.hint}</small>{/if}
				{#if problems[f.key]}<small class="problem">{problems[f.key]}</small>{/if}
			</label>
		{/each}

		<div class="actions">
			<button type="submit" class="btn" disabled={busy !== null}>
				{busy === 'create' ? 'Creating…' : 'Create'}
			</button>
			<button type="button" class="btn primary" disabled={busy !== null} onclick={() => submit(true)}>
				{busy === 'plan' ? 'Creating…' : 'Create and plan'}
			</button>
		</div>
	</form>
</div>

<style>
	.ivory-page {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
		padding: 1rem 1.25rem;
		overflow-y: auto;
	}
	header {
		border-bottom: 1px solid var(--border);
		padding-bottom: 0.6rem;
		margin-bottom: 0.8rem;
	}
	.back {
		font-size: var(--text-sm);
		color: var(--fg-dim);
	}
	h2 {
		margin: 0.3rem 0 0;
		font-size: var(--text-lg);
		letter-spacing: 0.3em;
		color: var(--heading);
	}
	form {
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
		max-width: 46rem;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		font-size: var(--text-sm);
		color: var(--label);
		min-width: 0;
	}
	em {
		font-style: normal;
		color: var(--fg-dim);
		font-size: var(--text-xs);
	}
	small {
		color: var(--fg-dim);
		font-size: var(--text-xs);
	}
	small.problem {
		color: var(--danger);
	}
	.pair {
		display: flex;
		gap: 1rem;
		flex-wrap: wrap;
	}
	.pair label:first-child {
		flex: 1 1 18rem;
	}
	input,
	select,
	textarea {
		background: var(--bg-pane);
		border: 1px solid var(--control-border);
		border-radius: 5px;
		color: var(--fg);
		font-family: inherit;
		font-size: var(--text-md);
		padding: 0.4rem 0.5rem;
		min-width: 0;
		box-sizing: border-box;
	}
	textarea {
		resize: vertical;
	}
	[aria-invalid='true'] {
		border-color: var(--danger);
	}
	.notice.error {
		color: var(--danger);
		margin: 0;
	}
	.actions {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
	.btn {
		background: var(--border);
		color: var(--fg);
		border: 1px solid var(--control-border);
		border-radius: 5px;
		padding: 0.45rem 0.9rem;
		font-family: inherit;
		font-size: var(--text-base);
		cursor: pointer;
		min-height: 2.5rem;
	}
	.btn.primary {
		border-color: var(--accent);
	}
	.btn:disabled {
		opacity: 0.6;
		cursor: default;
	}
</style>
