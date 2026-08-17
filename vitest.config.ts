import { defineConfig } from 'vitest/config';

// Headless core tests. Everything under tests/ imports only from src/core/ (plus the
// vendored paged.js file, which is read as text), so there is no Obsidian runtime, no DOM
// implementation and nothing to stub — the tests are the machine-checkable gate.
export default defineConfig({
	test: {
		include: ['tests/**/*.test.ts'],
		environment: 'node',
		coverage: {
			provider: 'v8',
			include: ['src/core/**/*.ts'],
			reporter: ['text', 'html'],
		},
	},
});
