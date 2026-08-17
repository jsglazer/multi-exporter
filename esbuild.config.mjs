import esbuild from 'esbuild';
import process from 'process';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';

const prod = process.argv[2] === 'production';

/**
 * Inlines a file as a string at build time: `import src from 'vendor-text:vendor/x.js'`.
 *
 * The vendored, patched paged.js is injected into the preview webview as source text, so it
 * must reach the bundle verbatim — not be parsed and tree-shaken as a module. Keeping the
 * vendored file a real `.js` on disk is what lets `findElement-null-guard.patch` apply to
 * it and lets the regression test read it.
 */
const vendorTextPlugin = {
	name: 'vendor-text',
	setup(build) {
		build.onResolve({ filter: /^vendor-text:/ }, (args) => ({
			path: path.resolve(process.cwd(), args.path.slice('vendor-text:'.length)),
			namespace: 'vendor-text',
		}));
		build.onLoad({ filter: /.*/, namespace: 'vendor-text' }, async (args) => ({
			contents: `export default ${JSON.stringify(await readFile(args.path, 'utf8'))};`,
			loader: 'js',
		}));
	},
};

const context = await esbuild.context({
	entryPoints: ['src/main.ts'],
	bundle: true,
	plugins: [vendorTextPlugin],
	// `builtinModules` lists bare specifiers only, so the `node:` prefixed forms this plugin
	// actually imports (`node:fs/promises`, `node:child_process`) need listing too.
	external: [
		'obsidian',
		'electron',
		...builtinModules,
		...builtinModules.map((name) => `node:${name}`),
	],
	format: 'cjs',
	target: 'es2018',
	logLevel: 'info',
	sourcemap: prod ? false : 'inline',
	treeShaking: true,
	outfile: 'main.js',
	minify: false,
});

if (prod) {
	await context.rebuild();
	process.exit(0);
} else {
	await context.watch();
}
