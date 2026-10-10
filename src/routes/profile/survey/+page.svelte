<script lang="ts">
	import { page } from '$app/state';
	import ProfileDraft from '$lib/components/ProfileDraft.svelte';
	import { emptyDraft, type Draft, type ViewDomain } from '$lib/profile-draft';
	import { emptyAnswers, nowUntil, SURVEY } from '$lib/survey';

	const REVIEW = SURVEY.length;
	const asked = SURVEY.findIndex((s) => s.id === page.url.searchParams.get('step'));

	let at = $state(asked >= 0 ? asked : 0);
	let answers = $state(emptyAnswers());
	// One blank row each, so a rows question shows its fields rather than a
	// lone "Add" button. Blank rows make nothing.
	answers.people.push({ name: '', kind: 'person', relation: '', line: '' });
	answers.projects.push({ name: '', line: '' });
	answers.now.push({ what: '', until: nowUntil(new Date()) });
	answers.text.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';

	let draft = $state<Draft>(emptyDraft());
	let ready = $state(false);
	let reading = $state(false);
	let notice = $state<string | null>(null);
	let saved = $state<{ added: number; skipped: number; people: number } | null>(null);
	let domains = $state<ViewDomain[]>([]);

	$effect(() => {
		void fetch('/api/profile')
			.then((r) => (r.ok ? r.json() : null))
			.then((v) => (domains = v?.domains ?? []))
			.catch(() => {});
	});

	async function go(i: number) {
		at = i;
		saved = null;
		ready = false;
		if (i === REVIEW) await read();
	}

	async function read() {
		reading = true;
		notice = null;
		const res = await fetch('/api/profile/survey', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ answers })
		}).catch(() => null);
		reading = false;
		if (!res?.ok) {
			notice = (await res?.json().catch(() => null))?.message ?? 'Your answers could not be read. Try again.';
			return;
		}
		draft = await res.json();
		ready = true;
	}

	function optIn(id: string, on: boolean) {
		answers.optedIn = on ? [...answers.optedIn, id] : answers.optedIn.filter((x) => x !== id);
	}
</script>

<div class="survey-page">
	<h1>Profile</h1>
	<section class="survey-section">
		<nav class="steps" aria-label="Questions">
			{#each SURVEY as s, i (s.id)}
				<button class="chip" class:on={at === i} aria-current={at === i ? 'step' : undefined} onclick={() => go(i)}>
					{s.title}
				</button>
			{/each}
			<button class="chip" class:on={at === REVIEW} aria-current={at === REVIEW ? 'step' : undefined} onclick={() => go(REVIEW)}>
				Review
			</button>
		</nav>

		{#if at < REVIEW}
			{@const step = SURVEY[at]}
			<article class="card">
				<h3>{step.title}</h3>
				<p class="hint">{step.intro} Leave anything blank to skip it. Nothing is saved until you review it.</p>
				{#each step.questions as q (q.id)}
					{#if q.type === 'text' || q.type === 'list' || q.type === 'entity'}
						<label class="q">
							{q.label}
							<input bind:value={answers.text[q.id]} placeholder={q.placeholder} maxlength="160" />
						</label>
					{:else if q.type === 'free'}
						{#if q.optIn}
							<label class="chk">
								<input
									type="checkbox"
									checked={answers.optedIn.includes(q.id)}
									onchange={(ev) => optIn(q.id, ev.currentTarget.checked)}
								/>
								{q.optIn}
							</label>
						{/if}
						{#if !q.optIn || answers.optedIn.includes(q.id)}
							<label class="q">
								{q.label}
								<textarea rows="3" bind:value={answers.text[q.id]} placeholder={q.placeholder} maxlength="4000"></textarea>
							</label>
							{#if q.optIn}
								<p class="hint">Private: only a chat agent can look it up, and it is never in the brief.</p>
							{/if}
						{/if}
					{:else if q.type === 'people'}
						<p class="q">{q.label}</p>
						{#each answers.people as p, i (i)}
							<div class="rowset">
								<label>Name <input bind:value={p.name} maxlength="40" placeholder="Aroha" /></label>
								<label>
									Is a
									<select bind:value={p.kind}>
										<option value="person">person</option>
										<option value="pet">pet</option>
									</select>
								</label>
								<label>To you <input bind:value={p.relation} maxlength="32" placeholder="partner" /></label>
								<label class="wide">
									One line about them
									<input bind:value={p.line} maxlength="160" placeholder="A GP who works weekend shifts." />
								</label>
								<button class="btn ghost" onclick={() => answers.people.splice(i, 1)}>Remove</button>
							</div>
						{/each}
						{#if answers.people.length < q.max}
							<button class="btn" onclick={() => answers.people.push({ name: '', kind: 'person', relation: '', line: '' })}>
								Add someone
							</button>
						{/if}
					{:else if q.type === 'projects'}
						<p class="q">{q.label}</p>
						{#each answers.projects as p, i (i)}
							<div class="rowset">
								<label>Project <input bind:value={p.name} maxlength="40" placeholder="Galaxy" /></label>
								<label class="wide">
									What it is
									<input bind:value={p.line} maxlength="120" placeholder="a self-hosted AI workspace" />
								</label>
								<button class="btn ghost" onclick={() => answers.projects.splice(i, 1)}>Remove</button>
							</div>
						{/each}
						{#if answers.projects.length < q.max}
							<button class="btn" onclick={() => answers.projects.push({ name: '', line: '' })}>Add a project</button>
						{/if}
					{:else}
						<p class="q">{q.label}</p>
						{#each answers.now as r, i (i)}
							<div class="rowset">
								<label class="wide">
									What
									<input bind:value={r.what} maxlength="160" placeholder="Moving house to Raglan." />
								</label>
								<label>Until <input type="date" bind:value={r.until} /></label>
								<button class="btn ghost" onclick={() => answers.now.splice(i, 1)}>Remove</button>
							</div>
						{/each}
						{#if answers.now.length < q.max}
							<button class="btn" onclick={() => answers.now.push({ what: '', until: nowUntil(new Date()) })}>
								Add another
							</button>
						{/if}
					{/if}
				{/each}
				<div class="row nav">
					{#if at > 0}<button class="btn" onclick={() => go(at - 1)}>Back</button>{/if}
					<button class="btn primary" onclick={() => go(at + 1)}>{at === REVIEW - 1 ? 'Review' : 'Next'}</button>
				</div>
			</article>
		{:else}
			<article class="card">
				<h3>Review</h3>
				{#if saved}
					<p class="notice" role="status">
						Saved {saved.added} {saved.added === 1 ? 'line' : 'lines'} to your profile{saved.skipped
							? `; ${saved.skipped} ${saved.skipped === 1 ? 'was' : 'were'} already there`
							: ''}.
					</p>
					<a class="btn primary" href="/profile">Back to your profile</a>
				{:else if reading}
					<p class="hint" role="status">Reading your answers…</p>
				{:else if notice}
					<p class="notice error" role="alert">{notice}</p>
					<button class="btn" onclick={read}>Try again</button>
				{:else if ready}
					<p class="hint">
						Everything your answers make, before any of it is saved. Change a line, move it, or leave it
						out. Going back to a question reads your answers again, and changes made here start over.
					</p>
					<ProfileDraft bind:draft {domains} source="survey" onsaved={(r) => (saved = r)} />
				{/if}
			</article>
		{/if}
	</section>
</div>

<style>
	.survey-page {
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
	.survey-section {
		max-width: 46rem;
	}
	@media (max-width: 720px) {
		.survey-page {
			padding: 0.75rem 0.85rem;
		}
	}
	h3 {
		margin: 0 0 0.6rem;
		font-size: var(--text-md);
		letter-spacing: 0.15em;
		text-transform: uppercase;
		color: var(--heading);
	}
	.steps {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin-bottom: 0.9rem;
	}
	.q {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		margin: 0 0 0.8rem;
		font-size: var(--text-base);
	}
	.q input,
	.q textarea {
		width: 100%;
		box-sizing: border-box;
	}
	.chk {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		min-height: var(--tap);
		font-size: var(--text-base);
	}
	.rowset {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 0.5rem;
		border-top: 1px solid var(--border);
		padding: 0.5rem 0;
	}
	.rowset label {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		font-size: var(--text-sm);
		color: var(--fg-dim);
	}
	.rowset label.wide {
		flex: 1 1 14rem;
	}
	.rowset label.wide input {
		width: 100%;
		box-sizing: border-box;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		flex-wrap: wrap;
	}
	.nav {
		margin-top: 1rem;
	}
	input:not([type='checkbox']):not([type='file']),
	select,
	textarea {
		background: var(--bg-pane);
		border: 1px solid var(--control-border);
		color: var(--fg);
		font-family: inherit;
		padding: 0.3rem 0.45rem;
		box-sizing: border-box;
	}
	textarea {
		resize: vertical;
	}
</style>
