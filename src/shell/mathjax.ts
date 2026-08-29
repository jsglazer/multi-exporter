import { toDataUri } from '../core/base64';

/**
 * Carrying MathJax's generated stylesheet into the guest webview.
 *
 * Obsidian renders maths with **MathJax CHTML**, which draws every glyph as an empty
 * `<mjx-c>` element and supplies the character itself from a `::before { content: … }` rule
 * in a stylesheet it builds at runtime. Serialising the note's DOM therefore captures the
 * *shape* of a formula and none of its content: without that stylesheet, `mjx-c` is an empty
 * inline element and a formula renders as literally nothing. That is why an exported page of
 * equations came out with its prose intact and every `$…$` missing — no error, no gap, just
 * absent.
 *
 * Two things have to cross into the guest, and neither does on its own:
 *
 * 1. **The stylesheet.** Its `textContent` is empty — MathJax inserts rules through the
 *    CSSOM — so it has to be read back out of `sheet.cssRules`. Obsidian does exactly this
 *    when it clones a document into a popout window, which is the same problem.
 * 2. **The fonts.** The `@font-face` rules point at `app://obsidian.md/…woff`, and the guest
 *    is an `about:blank` document in its own partition that cannot resolve that scheme —
 *    the same reason images are already inlined. So each font is fetched here, where the
 *    scheme does resolve, and rewritten into a `data:` URI.
 *
 * Everything is cached for the life of the plugin: the stylesheet does not change while
 * Obsidian is running, and a folder export would otherwise re-fetch a megabyte of fonts once
 * per note.
 */

/** MathJax's own id for the stylesheet it generates. Its `STYLESHEETID`, not a guess. */
export const MATHJAX_STYLE_ID = 'MJX-CHTML-styles';

/** Element MathJax CHTML wraps every formula in. Cheap way to ask "is there maths here?". */
const MATH_MARKER = '<mjx-container';

/** Resolved CSS, built once. `null` until the first document that actually needs it. */
let cachedCss: string | null = null;

/** Font URL -> data URI, so a bulk export fetches each face once. */
const fontCache = new Map<string, string>();

/** Whether a serialised document contains anything MathJax rendered. */
export function containsMath(html: string): boolean {
	return html.includes(MATH_MARKER);
}

/**
 * The MathJax stylesheet, fonts inlined, ready to drop into the guest document.
 *
 * Returns `''` when there is no maths to support or the stylesheet cannot be found — an
 * empty string is a valid stylesheet, so no caller needs a special case. Nothing here throws:
 * a document with unreadable fonts still exports, with the glyphs falling back to whatever
 * the guest can draw, which is enormously better than a blank formula.
 */
export async function mathJaxCss(html: string): Promise<string> {
	if (!containsMath(html)) return '';
	if (cachedCss !== null) return cachedCss;

	try {
		const source = readStyleSheet();
		cachedCss = source === '' ? '' : await inlineFonts(source);
	} catch (error) {
		console.warn('[multi-exporter] MathJax styles could not be collected; formulas may print blank.', error);
		cachedCss = '';
	}
	return cachedCss;
}

/**
 * The stylesheet's rules as text.
 *
 * `textContent` is deliberately not trusted first: MathJax adds its rules through
 * `sheet.insertRule`, which leaves the element's text empty, so reading it would silently
 * produce an empty stylesheet and print exactly the blank formulas this exists to fix. The
 * CSSOM is the source of truth; `textContent` is only the fallback for a browser that
 * refuses access to the rules.
 */
function readStyleSheet(): string {
	// `activeDocument` is whichever window has focus, which may be a popout that never
	// rendered maths and so never received the stylesheet. The main document is where
	// MathJax first inserts it, so it is the fallback rather than the other way round.
	const element =
		activeDocument.getElementById(MATHJAX_STYLE_ID) ??
		// eslint-disable-next-line obsidianmd/prefer-active-doc -- the fallback IS the main document
		document.getElementById(MATHJAX_STYLE_ID);
	if (!(element instanceof HTMLStyleElement)) return '';

	try {
		const rules = element.sheet?.cssRules;
		if (rules !== undefined && rules.length > 0) {
			const text: string[] = [];
			for (let index = 0; index < rules.length; index++) {
				const rule = rules[index];
				if (rule !== undefined) text.push(rule.cssText);
			}
			return text.join('\n');
		}
	} catch {
		// A stylesheet whose rules cannot be read; fall through to its text.
	}
	return element.textContent ?? '';
}

/** Any `url(...)` in the stylesheet, quoted or not, captured without its wrapper. */
const CSS_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

/**
 * Replace every font URL in the stylesheet with the bytes it points at.
 *
 * Failures are per-font and silent by design: one face that cannot be read costs those
 * glyphs their exact shape, and leaving its original `app://` URL in place is harmless —
 * the guest simply cannot load it, which is where this started.
 */
async function inlineFonts(css: string): Promise<string> {
	const urls = new Set<string>();
	for (const match of css.matchAll(CSS_URL)) {
		const url = match[2];
		if (url !== undefined && !url.startsWith('data:')) urls.add(url);
	}

	await Promise.all([...urls].map((url) => cacheFont(url)));

	return css.replace(CSS_URL, (whole: string, _quote: string, url: string) => {
		const inlined = fontCache.get(url);
		return inlined === undefined ? whole : `url(${inlined})`;
	});
}

async function cacheFont(url: string): Promise<void> {
	if (fontCache.has(url)) return;
	try {
		// Plain `fetch`, and the lint rule is suppressed deliberately. These are `app://` URLs
		// served by Obsidian's *own* protocol handler for files inside the application bundle —
		// the renderer resolves that scheme, and `requestUrl`, which is an HTTP client, cannot.
		// This is a read from the running app, not a network request; the rule is guarding
		// against something else.
		// eslint-disable-next-line no-restricted-globals
		const response = await fetch(url);
		if (!response.ok) return;
		const bytes = new Uint8Array(await response.arrayBuffer());
		fontCache.set(url, toDataUri(fontMimeType(url), bytes));
	} catch {
		// Leave it out; the face falls back rather than failing the export.
	}
}

/** MathJax ships woff2 and woff; the extension is the only thing that distinguishes them. */
function fontMimeType(url: string): string {
	const path = url.split('?')[0] ?? url;
	if (path.endsWith('.woff2')) return 'font/woff2';
	if (path.endsWith('.woff')) return 'font/woff';
	if (path.endsWith('.otf')) return 'font/otf';
	if (path.endsWith('.ttf')) return 'font/ttf';
	return 'application/octet-stream';
}
