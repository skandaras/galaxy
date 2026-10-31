<script lang="ts">
	import { BACKDROP_COLS, BACKDROP_ROWS, generateGalaxy } from '$lib/galaxy-art';

	let { animate = true }: { animate?: boolean } = $props();

	/** One full revolution. Deliberately slow — this is ambient, not a feature. */
	const REVOLUTION_MS = 240_000;
	/** Redraw cadence. The art is character-quantised, so ~5fps is plenty. */
	const FRAME_MS = 200;

	let art = $state(generateGalaxy(BACKDROP_COLS, BACKDROP_ROWS));

	/**
	 * Whether the person has asked for less motion, kept live. It used to be
	 * read once when the effect started, so turning the setting on in the OS
	 * left the spiral turning until the next reload.
	 */
	let reduced = $state(false);
	$effect(() => {
		const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
		if (!query) return;
		reduced = query.matches;
		const changed = (e: MediaQueryListEvent) => (reduced = e.matches);
		query.addEventListener('change', changed);
		return () => query.removeEventListener('change', changed);
	});

	$effect(() => {
		if (!animate || reduced) return;

		// A phone renders the same 110x34 grid as a desktop, at a size where most
		// of it is off the side of the screen anyway, and pays for it out of a
		// battery. Half the cadence is still ambient; nobody watches the backdrop
		// closely enough to count frames.
		const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
		const frameMs = coarse ? FRAME_MS * 2 : FRAME_MS;

		let raf = 0;
		let last = -Infinity;
		// rAF (not setInterval) so the browser suspends this on a hidden tab.
		const tick = (t: number) => {
			raf = requestAnimationFrame(tick);
			if (t - last < frameMs) return;
			last = t;
			const rotation = ((t % REVOLUTION_MS) / REVOLUTION_MS) * Math.PI * 2;
			art = generateGalaxy(BACKDROP_COLS, BACKDROP_ROWS, { rotation });
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	});
</script>

<div class="backdrop" aria-hidden="true">
	<div class="nebula"></div>
	<pre>{art}</pre>
</div>

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: var(--z-backdrop);
		display: flex;
		align-items: center;
		justify-content: center;
		overflow: hidden;
		pointer-events: none;
		user-select: none;
	}
	/* A faint wash of the theme's two accents behind the characters, so the
	   spiral has depth to sit in rather than floating on flat black. The opacity
	   is the bound: at its brightest point 7% took Galaxy's dim text to 4.36:1
	   against the page, under AA; at 4% every preset with the backdrop on stays
	   at or above 4.5:1. */
	.nebula {
		position: absolute;
		inset: -10%;
		background:
			radial-gradient(ellipse 45% 35% at 35% 45%, var(--galaxy, var(--accent)), transparent 70%),
			radial-gradient(ellipse 35% 30% at 68% 58%, var(--accent-2, var(--accent)), transparent 70%);
		opacity: 0.04;
		filter: blur(30px);
	}
	pre {
		position: relative;
		margin: 0;
		/* Deliberately not --font-mono. The art is made of characters and needs
		   every glyph the same width; --font-galaxy is fixed in themeCss and no
		   setting writes to it, so no font choice can distort the spiral. */
		font-family: var(--font-galaxy);
		/* Falls back to the accent, which is what this was pinned to before the
		   backdrop had a colour of its own — so a theme saved without one is
		   unchanged. */
		color: var(--galaxy, var(--accent));
		opacity: 0.16;
		font-size: clamp(8px, 1.1vw, 14px);
		line-height: 1.25;
		white-space: pre;
	}
</style>
