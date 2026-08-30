<script lang="ts">
	/**
	 * The lattice as a star chart, in three dimensions.
	 *
	 * Still one canvas and still no dependency. That is not a compromise here:
	 * the coordinates are already three-dimensional and already stable, computed
	 * by the layout sweep, so what was missing was never a graphics library but a
	 * camera and a projection — about eighty lines. A 3D library would have been
	 * by far the heaviest thing in this project, and Galaxy is a progressive web
	 * app people install on phones.
	 *
	 * The layout is untouched by this. `cortex-layout.ts` runs a true 2D pass for
	 * x and y and then relaxes z alone with x and y frozen, precisely so that
	 * turning on a 3D view would *lift* the nodes out of the plane rather than
	 * reshuffle them. This is that view. Nothing has moved; you can now see the
	 * axis that was always there, and z means something specific — how much a
	 * node's placement was compromised by flattening, so the parts of the chart
	 * that bulge toward you are the parts the flat map was lying about.
	 *
	 * Nothing animates on its own. The camera moves while a pointer is down and
	 * at no other time, so there is no simulation, no idle loop and no battery to
	 * burn — which keeps `prefers-reduced-motion` a non-question rather than a
	 * special case.
	 *
	 * This canvas is aria-hidden. The list beside it on the page is the real
	 * interface for anyone not looking at pixels, and it is the same list a
	 * sighted person clicks — not a hidden parallel that quietly rots.
	 */
	interface MapNode {
		id: string;
		name: string;
		x: number | null;
		y: number | null;
		z: number | null;
		isConvergence: boolean;
		degree: number;
		circuits?: string[] | null;
	}
	interface MapEdge {
		source: string;
		target: string;
		weight: number;
	}

	let {
		nodes = [],
		edges = [],
		selectedId = null,
		onselect,
		areaNames,
		/** Injected in tests; at runtime there is always a localStorage. */
		storage = undefined
	}: {
		nodes?: MapNode[];
		edges?: MapEdge[];
		selectedId?: string | null;
		onselect?: (id: string | null) => void;
		/** Area id → display name, so the chart can label a cluster. */
		areaNames?: Map<string, string>;
		storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
	} = $props();

	const VIEW_KEY = 'galaxy:cortex-view';

	let canvas = $state<HTMLCanvasElement>();
	let wrap = $state<HTMLDivElement>();
	let scale = $state(1);
	let originX = $state(0);
	let originY = $state(0);
	/**
	 * Yaw about the screen's vertical axis, pitch about its horizontal one.
	 *
	 * A default tilt rather than dead flat, so the depth is visible the moment
	 * the page opens rather than being something you have to discover. It is a
	 * constant, so the chart still looks the same every time — which is most of
	 * why the coordinates are precomputed at all.
	 */
	let yaw = $state(0.35);
	let pitch = $state(-0.42);
	let ready = $state(false);
	/** 'pan' on a left drag, 'rotate' on the middle button or with shift held. */
	let mode = $state<'pan' | 'rotate' | null>(null);
	/** Latched by the button, for anyone without a middle button to hold. */
	let rotateLatched = $state(false);
	let moved = false;
	let lastX = 0;
	let lastY = 0;
	let frame = 0;

	const store = () => {
		if (storage !== undefined) return storage;
		return typeof localStorage === 'undefined' ? null : localStorage;
	};

	/**
	 * A node the sweep has not placed yet — created in the last few minutes —
	 * still has to be somewhere, or it is invisible until the next tick and looks
	 * like a write that failed. A deterministic ring keeps it stable between
	 * redraws until it gets a real position.
	 */
	function placed(node: MapNode, i: number, total: number) {
		if (node.x !== null && node.y !== null) return { x: node.x, y: node.y, z: node.z ?? 0 };
		const angle = (i / Math.max(total, 1)) * Math.PI * 2;
		return { x: Math.cos(angle) * 200, y: Math.sin(angle) * 200, z: 0 };
	}

	const points = $derived(new Map(nodes.map((n, i) => [n.id, placed(n, i, nodes.length)])));

	/**
	 * How far out of the plane to lift the nodes.
	 *
	 * `z` is a *correction* to a flat layout, not a third full dimension — it
	 * records how much a node's placement was compromised by flattening — so on
	 * a real lattice it spans under a tenth of what x and y do. Drawn at its
	 * stored scale the chart is a sheet you can tilt, and the depth that is
	 * genuinely there is invisible.
	 *
	 * So the depth axis is scaled to a fixed fraction of the planar spread. This
	 * is a pure scalar on one axis: every node keeps exactly its share of the
	 * depth the layout computed, nothing is invented and nothing is reordered.
	 * Deriving it from the lattice's own spread rather than picking a constant is
	 * what makes it hold at seventeen concepts and at seventeen hundred, where a
	 * number tuned by eye on a small lattice would flatten out.
	 *
	 * Nothing about `cortex-layout.ts` changes. That file runs a true 2D pass and
	 * then relaxes z alone with x and y frozen, expressly so a 3D view could lift
	 * the nodes rather than reshuffle them. This is the lift.
	 */
	const DEPTH_FRACTION = 0.45;
	const depthLift = $derived.by(() => {
		let planar = 1;
		let depth = 0;
		for (const p of points.values()) {
			planar = Math.max(planar, Math.abs(p.x), Math.abs(p.y));
			depth = Math.max(depth, Math.abs(p.z));
		}
		// A lattice with no depth at all — one node, or a layout that has not run
		// — must not divide by zero into an infinite lift.
		if (depth < 0.001) return 1;
		return (planar * DEPTH_FRACTION) / depth;
	});

	/**
	 * How far the camera sits from the middle of the lattice, in model units.
	 *
	 * Derived from the lattice's own size rather than fixed, so perspective is
	 * the same gentle amount whether there are twelve concepts or twelve hundred.
	 * Large multiple: enough foreshortening to read as depth, not enough to make
	 * the near side of a cluster loom.
	 */
	const radius = $derived.by(() => {
		let max = 1;
		for (const p of points.values()) max = Math.max(max, Math.hypot(p.x, p.y, p.z * depthLift));
		return max;
	});
	const focal = $derived(radius * 3.2);

	/** Model point → camera space, then to the flat page. */
	function project(p: { x: number; y: number; z: number }) {
		const cosY = Math.cos(yaw);
		const sinY = Math.sin(yaw);
		const cosP = Math.cos(pitch);
		const sinP = Math.sin(pitch);
		const z = p.z * depthLift;
		// Yaw first, about the vertical axis, then pitch about the horizontal one.
		const x1 = p.x * cosY + z * sinY;
		const z1 = -p.x * sinY + z * cosY;
		const y2 = p.y * cosP - z1 * sinP;
		const z2 = p.y * sinP + z1 * cosP;
		// Perspective, clamped so a node that ends up behind the camera on a wild
		// rotation folds toward the horizon instead of inverting through it.
		const k = focal / Math.max(focal + z2, focal * 0.15);
		return { x: x1 * k, y: y2 * k, depth: z2, k };
	}

	/** Everything the frame needs, computed once and drawn back to front. */
	const projected = $derived.by(() => {
		const out = new Map<
			string,
			{ sx: number; sy: number; depth: number; k: number }
		>();
		for (const [id, p] of points) {
			const q = project(p);
			out.set(id, {
				sx: q.x * scale + originX,
				sy: q.y * scale + originY,
				depth: q.depth,
				k: q.k
			});
		}
		return out;
	});

	const maxDegree = $derived(nodes.reduce((m, n) => Math.max(m, n.degree), 0));

	/** Fit everything into view, through the camera as it is now. */
	function fit() {
		if (!wrap || !nodes.length) return;
		const flat = [...points.values()].map(project);
		const minX = Math.min(...flat.map((p) => p.x));
		const maxX = Math.max(...flat.map((p) => p.x));
		const minY = Math.min(...flat.map((p) => p.y));
		const maxY = Math.max(...flat.map((p) => p.y));
		const w = wrap.clientWidth || 600;
		const h = wrap.clientHeight || 400;
		const pad = 60;
		// Bounds of what *this* viewer can see. The layout is computed over the
		// whole graph, so someone seeing part of it would otherwise be looking at
		// a corner of a chart mostly made of nodes they have no access to.
		const spanX = Math.max(maxX - minX, 1);
		const spanY = Math.max(maxY - minY, 1);
		scale = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY, 2);
		originX = w / 2 - ((minX + maxX) / 2) * scale;
		originY = h / 2 - ((minY + maxY) / 2) * scale;
		ready = true;
		draw();
	}

	/** Back to looking straight down at the plane, which is the 2D map. */
	function flatten() {
		yaw = 0;
		pitch = 0;
		saveView();
		fit();
	}

	function saveView() {
		try {
			store()?.setItem(VIEW_KEY, JSON.stringify({ yaw, pitch }));
		} catch {
			// A browser with storage blocked still gets a working chart; it just
			// starts from the default angle every time.
		}
	}

	function loadView() {
		try {
			const raw = store()?.getItem(VIEW_KEY);
			if (!raw) return;
			const saved = JSON.parse(raw);
			if (typeof saved?.yaw === 'number') yaw = saved.yaw;
			if (typeof saved?.pitch === 'number') pitch = clampPitch(saved.pitch);
		} catch {
			// Nothing stored, or nothing parseable. The default angle is fine.
		}
	}

	/**
	 * Stop just short of the poles.
	 *
	 * Straight down the vertical axis the whole lattice collapses to a line, and
	 * past it the chart flips over — both of which read as the map having broken
	 * rather than as a rotation.
	 */
	const clampPitch = (v: number) => Math.max(-1.45, Math.min(1.45, v));

	function css(name: string, fallback: string): string {
		if (!wrap) return fallback;
		return getComputedStyle(wrap).getPropertyValue(name).trim() || fallback;
	}

	/**
	 * A hue per area, spread evenly around the wheel and keyed by the area's
	 * position in the sorted set so a colour does not change when an unrelated
	 * one is added. Areas are what the agents' context index is grouped by, so
	 * seeing them here is seeing what the agent sees.
	 *
	 * Deliberately not the theme accent: this is categorical data and one accent
	 * cannot carry it. Lightness and saturation are fixed to stay legible on both
	 * a near-black and a cream page.
	 */
	const areaHues = $derived.by(() => {
		const seen = [...new Set(nodes.flatMap((n) => n.circuits ?? []))].sort();
		return new Map(seen.map((id, i) => [id, Math.round((i * 360) / Math.max(seen.length, 1))]));
	});

	function areaColour(node: MapNode): string | null {
		const first = node.circuits?.[0];
		if (!first) return null;
		const hue = areaHues.get(first);
		return hue === undefined ? null : `hsl(${hue} 52% 62%)`;
	}

	function nodeRadius(node: MapNode): number {
		// Degree, not activation: the map's job is to show the shape of the mesh,
		// and how connected a concept is *is* that shape.
		return 3 + Math.min(Math.sqrt(node.degree) * 2.2, 9);
	}

	/**
	 * How brightly a concept burns: how connected it is, against the most
	 * connected thing this viewer can see.
	 *
	 * Relative rather than absolute, so a lattice of twenty has a brightest node
	 * and so does a lattice of two thousand. Square-rooted because degree is
	 * long-tailed — on a linear scale one hub washes out and everything else is
	 * an even, unreadable dim.
	 */
	function glowStrength(node: MapNode): number {
		if (maxDegree < 1) return 0;
		return Math.sqrt(node.degree / maxDegree);
	}

	/**
	 * One radial-gradient sprite per colour, drawn once and stamped thereafter.
	 *
	 * A gradient built per node per frame is the obvious way to write this and
	 * makes a rotation drag stutter on a phone at a few hundred concepts; a
	 * sprite is a `drawImage`. `shadowBlur` was the other candidate and is
	 * slower still with this many draws.
	 */
	const sprites = new Map<string, HTMLCanvasElement>();
	const SPRITE_PX = 64;

	function sprite(colour: string): HTMLCanvasElement | null {
		const cached = sprites.get(colour);
		if (cached) return cached;
		if (typeof document === 'undefined') return null;
		const c = document.createElement('canvas');
		c.width = SPRITE_PX;
		c.height = SPRITE_PX;
		const ctx = c.getContext('2d');
		if (!ctx) return null;
		const mid = SPRITE_PX / 2;
		const g = ctx.createRadialGradient(mid, mid, 0, mid, mid, mid);
		g.addColorStop(0, colour);
		g.addColorStop(0.35, colour);
		g.addColorStop(1, 'transparent');
		ctx.globalAlpha = 1;
		ctx.fillStyle = g;
		ctx.fillRect(0, 0, SPRITE_PX, SPRITE_PX);
		sprites.set(colour, c);
		return c;
	}

	function draw() {
		if (!canvas || !wrap) return;
		const ctx = canvas.getContext('2d');
		if (!ctx) return;

		const dpr = window.devicePixelRatio || 1;
		const w = wrap.clientWidth;
		const h = wrap.clientHeight;
		if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
			canvas.width = w * dpr;
			canvas.height = h * dpr;
		}
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, w, h);

		// Not --border. That colour is a deliberate whisper — docs/ACCESSIBILITY.md
		// puts it near 1.2:1 against the page, which is right for separating cards
		// and wrong for a line that carries meaning. An edge *is* the information
		// here, so it gets a colour the themes are actually held to.
		const dim = css('--fg-dim', '#888');
		const accent = css('--accent', '#7aa2f7');
		const fg = css('--fg', '#ddd');

		const at = (id: string) => projected.get(id) ?? null;

		// Far to near, so a connection behind a cluster is drawn behind it. The
		// flat map had no answer to this because it had no in front of.
		const order = [...nodes]
			.map((node) => ({ node, p: at(node.id) }))
			.filter((n): n is { node: MapNode; p: NonNullable<ReturnType<typeof at>> } => !!n.p)
			.sort((a, b) => b.p.depth - a.p.depth);

		ctx.lineCap = 'round';
		const drawn = [...edges]
			.map((e) => ({ e, a: at(e.source), b: at(e.target) }))
			.filter((x) => x.a && x.b)
			.sort((x, y) => (y.a!.depth + y.b!.depth) / 2 - (x.a!.depth + x.b!.depth) / 2);
		for (const { e, a, b } of drawn) {
			const touches = selectedId === e.source || selectedId === e.target;
			// Perspective already shrinks a far edge; fading it as well is what
			// separates a line running away from you from one lying across the view.
			const near = ((a!.k + b!.k) / 2 - 0.6) / 0.8;
			const depthFade = Math.max(0.25, Math.min(1, near));
			ctx.strokeStyle = touches ? accent : dim;
			// Weight is visible as opacity as well as width, so a strong
			// association reads as strong at a glance rather than on inspection.
			ctx.globalAlpha = touches ? 0.95 : (0.25 + e.weight * 0.45) * depthFade;
			ctx.lineWidth = Math.max(0.5, e.weight * 2 * Math.min(scale, 1.5) * ((a!.k + b!.k) / 2));
			ctx.beginPath();
			ctx.moveTo(a!.sx, a!.sy);
			ctx.lineTo(b!.sx, b!.sy);
			ctx.stroke();
		}
		ctx.globalAlpha = 1;

		for (const { node, p } of order) {
			// Perspective scale, so a node further away is smaller. Clamped like the
			// zoom is: a dot has to stay clickable.
			const r = nodeRadius(node) * Math.min(Math.max(scale, 0.6), 1.6) * Math.min(p.k, 1.6);
			const selected = node.id === selectedId;
			const colour = selected ? accent : node.isConvergence ? accent : (areaColour(node) ?? dim);

			// The glow, and the thing it says: the more a concept connects, the
			// brighter it burns. Additive, so where two well-connected concepts sit
			// near each other the space between them lights up — which is what a
			// dense region of the lattice actually is.
			const strength = glowStrength(node);
			const halo = sprite(colour);
			if (halo && (strength > 0 || selected)) {
				const size = r * (2.6 + strength * 5.5) * 2;
				ctx.globalCompositeOperation = 'lighter';
				ctx.globalAlpha = (0.09 + strength * 0.38) * (selected ? 1.6 : 1) * Math.min(p.k, 1.2);
				ctx.drawImage(halo, p.sx - size / 2, p.sy - size / 2, size, size);
				ctx.globalCompositeOperation = 'source-over';
			}

			ctx.globalAlpha = selected ? 1 : Math.max(0.5, Math.min(1, p.k));
			ctx.fillStyle = colour;
			ctx.beginPath();
			ctx.arc(p.sx, p.sy, r, 0, Math.PI * 2);
			ctx.fill();

			if (node.isConvergence) {
				// A bridge gets a ring rather than a different colour, so it still
				// reads as one in a theme where the accent is the only strong hue.
				ctx.strokeStyle = accent;
				ctx.lineWidth = 1.2;
				ctx.beginPath();
				ctx.arc(p.sx, p.sy, r + 3.5, 0, Math.PI * 2);
				ctx.stroke();
			}
			if (selected) {
				ctx.strokeStyle = accent;
				ctx.lineWidth = 2;
				ctx.beginPath();
				ctx.arc(p.sx, p.sy, r + 7, 0, Math.PI * 2);
				ctx.stroke();
			}

			// Labels only once there is room for them, and always for the selection.
			if (scale > 0.55 || selected) {
				ctx.globalAlpha = selected ? 1 : 0.8 * Math.min(p.k, 1);
				ctx.fillStyle = selected ? fg : dim;
				ctx.font = `${selected ? 600 : 400} 11px var(--font-ui, system-ui)`;
				ctx.textAlign = 'center';
				ctx.fillText(node.name, p.sx, p.sy - r - 6);
			}
			ctx.globalAlpha = 1;
		}

		// Zoomed far enough out that node labels are gone, the areas are what is
		// left to navigate by — drawn at the centre of mass of each one's nodes.
		if (scale <= 0.55 && areaHues.size) {
			const centres = new Map<string, { x: number; y: number; n: number }>();
			for (const node of nodes) {
				const id = node.circuits?.[0];
				const p = at(node.id);
				if (!id || !p) continue;
				const acc = centres.get(id) ?? { x: 0, y: 0, n: 0 };
				centres.set(id, { x: acc.x + p.sx, y: acc.y + p.sy, n: acc.n + 1 });
			}
			ctx.textAlign = 'center';
			ctx.font = '600 13px var(--font-ui, system-ui)';
			for (const [id, c] of centres) {
				if (c.n < 2) continue;
				ctx.fillStyle = `hsl(${areaHues.get(id)} 52% 62%)`;
				ctx.globalAlpha = 0.85;
				ctx.fillText(areaNames?.get(id) ?? id, c.x / c.n, c.y / c.n);
			}
			ctx.globalAlpha = 1;
		}
	}

	/** One redraw per frame however many events arrive, so a drag cannot queue up. */
	function schedule() {
		if (frame) return;
		frame = requestAnimationFrame(() => {
			frame = 0;
			draw();
		});
	}

	function nodeAt(clientX: number, clientY: number): string | null {
		if (!canvas) return null;
		const rect = canvas.getBoundingClientRect();
		const sx = clientX - rect.left;
		const sy = clientY - rect.top;
		let best: { id: string; d: number; depth: number } | null = null;
		for (const node of nodes) {
			const p = projected.get(node.id);
			if (!p) continue;
			const d = Math.hypot(p.sx - sx, p.sy - sy);
			const hit =
				nodeRadius(node) * Math.min(Math.max(scale, 0.6), 1.6) * Math.min(p.k, 1.6) + 8;
			if (d > hit) continue;
			// Nearest to the pointer, and on a tie the one in front — which is the
			// one whose pixels you actually clicked on.
			if (!best || d < best.d - 2 || (Math.abs(d - best.d) <= 2 && p.depth < best.depth)) {
				best = { id: node.id, d, depth: p.depth };
			}
		}
		return best?.id ?? null;
	}

	function onpointerdown(e: PointerEvent) {
		// Middle button, shift-drag, or the latch for anyone with neither.
		mode = e.button === 1 || e.shiftKey || rotateLatched ? 'rotate' : 'pan';
		// Chrome puts up its autoscroll cursor on a middle press otherwise, and
		// then eats the drag.
		if (e.button === 1) e.preventDefault();
		moved = false;
		lastX = e.clientX;
		lastY = e.clientY;
		canvas?.setPointerCapture(e.pointerId);
	}

	function onpointermove(e: PointerEvent) {
		if (!mode) return;
		const dx = e.clientX - lastX;
		const dy = e.clientY - lastY;
		if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
		if (mode === 'rotate') {
			// A drag across the full width is most of a turn, which is about the
			// rate at which a rotation stays legible rather than whipping round.
			yaw += dx * 0.008;
			pitch = clampPitch(pitch + dy * 0.008);
		} else {
			originX += dx;
			originY += dy;
		}
		lastX = e.clientX;
		lastY = e.clientY;
		schedule();
	}

	function onpointerup(e: PointerEvent) {
		const wasRotating = mode === 'rotate';
		mode = null;
		canvas?.releasePointerCapture(e.pointerId);
		if (wasRotating && moved) {
			saveView();
			return;
		}
		// A drag that ends on a node is a pan, not a click on it.
		if (!moved) onselect?.(nodeAt(e.clientX, e.clientY));
	}

	function onwheel(e: WheelEvent) {
		e.preventDefault();
		if (!canvas) return;
		const rect = canvas.getBoundingClientRect();
		const sx = e.clientX - rect.left;
		const sy = e.clientY - rect.top;
		const factor = Math.exp(-e.deltaY * 0.0015);
		const next = Math.min(Math.max(scale * factor, 0.1), 6);
		// Zoom toward the pointer rather than the centre, so the thing being
		// looked at is the thing that stays put.
		originX = sx - ((sx - originX) / scale) * next;
		originY = sy - ((sy - originY) / scale) * next;
		scale = next;
		schedule();
	}

	$effect(() => {
		// Re-fit whenever the lattice itself changes, and redraw on selection.
		void nodes.length;
		void edges.length;
		if (!ready) {
			loadView();
			fit();
		} else {
			schedule();
		}
	});

	$effect(() => {
		void selectedId;
		void scale;
		void yaw;
		void pitch;
		schedule();
	});

	$effect(() => {
		if (!wrap) return;
		const observer = new ResizeObserver(() => (ready ? schedule() : fit()));
		observer.observe(wrap);
		return () => {
			observer.disconnect();
			if (frame) cancelAnimationFrame(frame);
		};
	});
</script>

<div class="map" bind:this={wrap}>
	<canvas
		bind:this={canvas}
		aria-hidden="true"
		{onpointerdown}
		{onpointermove}
		{onpointerup}
		{onwheel}
		onauxclick={(e) => e.preventDefault()}
		oncontextmenu={(e) => e.preventDefault()}
	></canvas>
	{#if nodes.length}
		<div class="hint">drag to pan · middle-drag or shift-drag to rotate · scroll to zoom</div>
		<div class="controls">
			<!-- The latch exists because a phone and most trackpads have no middle
			     button, and the canvas is the only way to turn the chart. -->
			<button
				class="ctl"
				class:on={rotateLatched}
				aria-pressed={rotateLatched}
				onclick={() => (rotateLatched = !rotateLatched)}>Rotate</button
			>
			<button class="ctl" onclick={flatten}>Flat</button>
			<button class="ctl" onclick={fit}>Fit</button>
		</div>
	{/if}
</div>

<style>
	.map {
		position: relative;
		flex: 1;
		min-width: 0;
		min-height: 240px;
		overflow: hidden;
	}
	canvas {
		display: block;
		width: 100%;
		height: 100%;
		touch-action: none;
		cursor: grab;
	}
	canvas:active {
		cursor: grabbing;
	}
	.hint {
		position: absolute;
		left: 0.75rem;
		bottom: 0.6rem;
		font-size: var(--text-sm);
		color: var(--fg-dim);
		pointer-events: none;
	}
	.controls {
		position: absolute;
		right: 0.75rem;
		top: 0.6rem;
		display: flex;
		gap: 0.3rem;
	}
	.ctl {
		font-size: var(--text-sm);
		padding: 0.25rem 0.6rem;
		color: var(--fg);
		background: var(--bg-pane);
		border: 1px solid var(--control-border);
		cursor: pointer;
	}
	.ctl.on {
		border-color: var(--accent);
		color: var(--heading);
	}
</style>
