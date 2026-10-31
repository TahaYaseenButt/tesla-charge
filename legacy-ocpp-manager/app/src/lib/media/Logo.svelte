<script lang="ts">
	let { class: className = '' }: { class: string } = $props();
	import Logo from '../media/Logo.png';
</script>

<img alt="Logo" src={Logo} class={className} />
