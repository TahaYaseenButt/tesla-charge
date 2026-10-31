import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const buildOutput = '../api/build';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),

	kit: {
		adapter: adapter({
			fallback: 'index.html',
			assets: buildOutput,
			pages: buildOutput,
			precompress: true,
			strict: true
		})
	}
};

export default config;
