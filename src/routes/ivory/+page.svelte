<script lang="ts">
	interface Project {
		slug: string;
		title: string;
		question: string;
		disciplines: string[];
		openTasks: number;
		status: { text: string; at: string; by: string } | null;
	}
	interface Index {
		configured: boolean;
		repo: string;
		repoUrl?: string;
		groups?: { discipline: string; projects: Project[] }[];
		projectCount?: number;
	}

	let data = $state<Index | null>(null);
	let failure = $state<string | null>(null);

	async function load() {
		failure = null;
		const res = await fetch('/api/ivory/projects');
		const body = await res.json().catch(() => ({}));
		if (!res.ok) {
			failure = body.message ?? `The Shelf could not be read (${res.status})`;
			return;
		}
		data = body;
	}

	$effect(() => {
		void load();
	});
</script>

<div class="ivory-page">
	<header>
		<h2>Ivory Tower</h2>
		<div class="head-actions">
			{#if data?.repoUrl}
				<a class="repo" href={data.repoUrl} target="_blank" rel="noopener">{data.repo}</a>
			{/if}
			{#if data?.configured}<a class="new" href="/ivory/new">New project</a>{/if}
		</div>
	</header>

	{#if failure}
		<p class="notice error" role="alert">{failure}</p>
	{:else if !data}
		<p class="notice">Reading the Shelf…</p>
	{:else if !data.configured}
		<p class="notice">
			The Shelf is <code>{data.repo}</code>, but no GitHub token is configured. An admin can add one
			in Admin → Settings → GitHub.
		</p>
	{:else if !data.projectCount}
		<p class="notice">
			No projects on the Shelf yet. <a href="/ivory/new">Create one</a>, or run “Set up Shelf” in
			Admin → Settings to write the templates and a sample project to <code>{data.repo}</code>.
		</p>
	{:else}
		{#each data.groups ?? [] as group (group.discipline)}
			<section>
				<h3>{group.discipline}</h3>
				<ul>
					{#each group.projects as p (p.slug)}
						<li>
							<a class="project" href="/ivory/{p.slug}">
								<span class="title">{p.title}</span>
								{#if p.question}<span class="question">{p.question}</span>{/if}
								{#if p.status}<span class="status" title="{p.status.by}, {p.status.at} UTC">{p.status.text}</span>{/if}
								<span class="meta">
									<span class="num">{p.openTasks}</span> open task{p.openTasks === 1 ? '' : 's'}
									{#if p.disciplines.length > 1}
										· also in {p.disciplines.filter((d) => d !== group.discipline).join(', ')}
									{/if}
								</span>
							</a>
						</li>
					{/each}
				</ul>
			</section>
		{/each}
	{/if}
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
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
		border-bottom: 1px solid var(--border);
		padding-bottom: 0.6rem;
		margin-bottom: 0.8rem;
	}
	h2 {
		margin: 0;
		font-size: var(--text-lg);
		letter-spacing: 0.3em;
		color: var(--heading);
	}
	h3 {
		margin: 0.4rem 0 0.5rem;
		font-size: var(--text-md);
		letter-spacing: 0.15em;
		text-transform: uppercase;
		color: var(--heading);
	}
	.head-actions {
		display: flex;
		align-items: baseline;
		gap: 1rem;
		flex-wrap: wrap;
	}
	.new {
		border: 1px solid var(--accent);
		border-radius: 5px;
		padding: 0.3rem 0.7rem;
		color: var(--fg);
		text-decoration: none;
		font-size: var(--text-sm);
	}
	.status {
		font-size: var(--text-sm);
		color: var(--fg-dim);
		border-left: 2px solid var(--accent);
		padding-left: 0.45rem;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.repo {
		font-size: var(--text-sm);
		color: var(--fg-dim);
	}
	.notice {
		color: var(--fg-dim);
		max-width: 60ch;
	}
	.notice.error {
		color: var(--danger);
	}
	section {
		margin-bottom: 1rem;
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 20rem), 1fr));
		gap: 0.6rem;
	}
	.project {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 0.7rem 0.8rem;
		color: var(--fg);
		text-decoration: none;
		height: 100%;
		box-sizing: border-box;
	}
	.project:hover {
		border-color: var(--accent);
	}
	.title {
		color: var(--heading);
		font-size: var(--text-md);
	}
	.question {
		font-size: var(--text-sm);
	}
	.meta {
		font-size: var(--text-sm);
		color: var(--fg-dim);
	}
	.num {
		font-family: var(--font-mono);
	}
</style>
