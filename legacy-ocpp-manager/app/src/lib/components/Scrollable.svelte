<script lang="ts">
	import type { Snippet } from 'svelte';

	const {
		maxHeight,
		class: className,
		children
	}: { maxHeight: string; class?: string; children?: Snippet<[]> } = $props();
</script>

<div class={`scrollable-container ${className || ''}`} style={`max-height: ${maxHeight};`}>
	{@render children?.()}
</div>

<style>
	.scrollable-container {
		overflow-y: auto;
		scroll-behavior: smooth; /* For smooth scrolling */
	}
</style>
