/**
 * `vendor-text:` imports are inlined as strings by the esbuild plugin in
 * `esbuild.config.mjs`. Used for the vendored paged.js, which is injected into the preview
 * webview as source rather than bundled as a module.
 */
declare module 'vendor-text:*' {
	const contents: string;
	export default contents;
}
