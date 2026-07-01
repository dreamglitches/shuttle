import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter({
			pages: 'dist',
			assets: 'dist',
			fallback: 'index.html',
			precompress: false,
			strict: false
		}),
		// All routes are rendered client-side (SPA mode)
		prerender: {
			handleMissingId: 'ignore'
		}
	}
};

export default config;
