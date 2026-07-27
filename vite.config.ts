import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	test: {
		include: ['src/**/*.test.ts'],
		// Sets a per-worker DATA_DIR before any test module is imported, so
		// parallel suites don't share one SQLite file. See src/test-setup.ts.
		setupFiles: ['src/test-setup.ts']
	}
});
