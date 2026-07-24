<script lang="ts">
	import { GALAXY_BACKDROP } from '$lib/galaxy-art';
</script>

<div class="backdrop" aria-hidden="true">
	<pre>{GALAXY_BACKDROP}</pre>
</div>

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		overflow: hidden;
		pointer-events: none;
		user-select: none;
	}
	pre {
		margin: 0;
		color: var(--accent);
		opacity: 0.16;
		font-size: clamp(8px, 1.1vw, 14px);
		line-height: 1.25;
		white-space: pre;
		animation: breathe 11s ease-in-out infinite;
	}
	@keyframes breathe {
		0%,
		100% {
			opacity: 0.16;
		}
		50% {
			opacity: 0.09;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		pre {
			animation: none;
		}
	}
</style>
