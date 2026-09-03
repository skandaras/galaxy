import js from '@eslint/js';
import globals from 'globals';
import ts from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
import svelteConfig from './svelte.config.js';

/**
 * Lint only — there is no formatter here on purpose.
 *
 * The tree is hand-formatted and consistent, and a one-shot reformat would
 * rewrite every file and bury the history of all of them in a single commit.
 * What was missing was not style but the checks a type-aware linter does that
 * `svelte-check` does not: `no-floating-promises` finds the fire-and-forget
 * promise that ends the process, and the svelte a11y rules hold the guarantees
 * docs/ACCESSIBILITY.md makes, which were until now kept by review alone.
 */
export default ts.config(
	{
		ignores: [
			'build/',
			'.svelte-kit/',
			'eslint.config.js',
			'node_modules/',
			'drizzle/',
			'static/',
			'package-lock.json'
		]
	},
	js.configs.recommended,
	...ts.configs.recommended,
	...svelte.configs.recommended,
	{
		languageOptions: {
			globals: { ...globals.browser, ...globals.node }
		}
	},
	{
		// Components are `<script lang="ts">`, so the svelte parser has to hand the
		// script block to the TypeScript one or every type annotation is a syntax
		// error.
		files: ['**/*.svelte', '**/*.svelte.ts'],
		languageOptions: {
			parserOptions: { parser: ts.parser, svelteConfig }
		}
	},
	{
		// Type-aware rules, which are the reason this exists at all. Scoped to the
		// rules that pay for the extra pass rather than turning on the whole
		// type-checked preset, which would land hundreds of findings at once and
		// mean nobody reads any of them.
		// .ts only. Type-aware linting inside .svelte needs the svelte parser to
		// forward to the TS one, and the bug this rule exists for lives in the
		// server engine, not in a component.
		files: ['**/*.ts'],
		// The service worker is compiled by SvelteKit under its own tsconfig and is
		// not part of the app project, so the type-aware pass cannot see it.
		ignores: ['src/service-worker.ts', 'drizzle.config.ts'],
		languageOptions: { parserOptions: { projectService: true } },
		rules: {
			'@typescript-eslint/no-floating-promises': 'error'
		}
	},
	{
		// Scripts are plain node ESM: the mock provider and the two smoke suites.
		files: ['scripts/**/*.mjs'],
		languageOptions: { globals: globals.node },
		rules: { '@typescript-eslint/no-floating-promises': 'off' }
	},
	{
		rules: {
			// TypeScript resolves globals from its own lib, and knows about
			// RequestInit and NotificationPermission. `no-undef` does not, and only
			// ever produces false positives on a typed file.
			'no-undef': 'off',
			// A regex is allowed to be about a control character: the BOM strip in
			// attachments.ts and the NUL-byte binary check in research.ts are both
			// doing exactly what they look like.
			'no-control-regex': 'off',
			'no-irregular-whitespace': ['error', { skipRegExps: true, skipStrings: true }],
			// A leading underscore already means "deliberately unused" throughout
			// this codebase — `_req` in the fake adapters, `_childStep`, `_drop`.
			'@typescript-eslint/no-unused-vars': [
				'error',
				{
					argsIgnorePattern: '^_',
					varsIgnorePattern: '^_',
					caughtErrorsIgnorePattern: '^_'
				}
			]
		}
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts'],
		rules: {
			// A bare expression in a `$effect` is how Svelte 5 declares a
			// dependency. It is the idiom, not a mistake.
			'@typescript-eslint/no-unused-expressions': 'off',
			// Every `{@html}` in this tree was audited when it was written and each
			// one sanitises: DOMPurify in Markdown.svelte and SvgBlock.svelte,
			// mermaid's own strict mode, an esc()'d diff in /code, and theme CSS
			// that normalizeTheme has already stripped of breakout characters. A
			// blanket error here would be five permanent suppressions instead.
			'svelte/no-at-html-tags': 'off',
			// Both of these are about situations this app does not have. There is
			// no `base` path configured, so resolve() would be a no-op on every
			// link; and the Sets and Maps flagged are read through explicit state,
			// never relied on to be deeply reactive. Worth revisiting if either
			// stops being true.
			'svelte/no-navigation-without-resolve': 'off',
			'svelte/prefer-svelte-reactivity': 'off',
			'svelte/prefer-writable-derived': 'off'
		}
	},
);
