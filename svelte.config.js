import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter(),
		// What a page may load, and from where. Every reply is model-authored
		// markup shown beside the person's own data, and a model can be told what
		// to write by any page it reads, so nothing on screen is allowed to make
		// a request to another origin by being rendered: an image, a stylesheet
		// background, a media element. The interface itself loads nothing from
		// elsewhere, so this costs it nothing.
		//
		// script-src and style-src are left out on purpose. Naming either makes
		// SvelteKit add a nonce, and a nonce switches off 'unsafe-inline', which
		// the theme's <style> block and Svelte's own transitions depend on.
		csp: {
			directives: {
				'img-src': ['self', 'data:', 'blob:'],
				'media-src': ['self', 'data:', 'blob:'],
				'font-src': ['self', 'data:'],
				'connect-src': ['self'],
				'object-src': ['none'],
				'base-uri': ['self'],
				'form-action': ['self'],
				'frame-ancestors': ['none']
			}
		}
	}
};

export default config;
