import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default defineConfig({
	plugins: [sveltekit()],
	test: {
		include: ['src/**/*.test.ts'],
		env: {
			DATA_DIR: join(tmpdir(), 'galaxy-test-data')
		}
	}
});
