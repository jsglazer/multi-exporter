import type { App } from 'obsidian';
import { createExcalidrawAutomateInstance } from '../adapter/obsidian-internals';
import { EXCALIDRAW_FONT_IDS, FONT_SAMPLE_TEXT, excalidrawFontIds } from '../core/excalidraw';
import { extractFontFaceRules, fontFamiliesIn } from '../core/style-snapshot';
import { inlineFonts } from './mathjax';

/**
 * `@font-face` rules for the fonts a frozen note-embed box names, ready to travel into the guest.
 *
 * Two sources, because the fonts on an Excalidraw board come from two places:
 *
 * 1. **Excalidraw's own families** (Virgil, Excalifont, Cascadia, ...). The plugin registers these
 *    with `document.fonts.add(new FontFace(...))`, which leaves no stylesheet rule to read and no
 *    way to get a `FontFace`'s bytes back out. The public route is the one Excalidraw's own SVG
 *    export uses: a private `ExcalidrawAutomate` instance draws a line of text in that family and
 *    `createSVG(..., embedFont = true)` returns an SVG whose `<style>` carries the face as a data
 *    URI.
 * 2. **Anything else** a theme or snippet loaded with an ordinary `@font-face` rule, read out of
 *    the live document's stylesheets and inlined the same way MathJax's fonts are.
 *
 * System fonts need neither: the guest is the same Chromium on the same machine.
 */

/** Excalidraw font id -> its `@font-face` CSS. Only non-empty results are kept, so a font that was
 * still loading on the first export is tried again on the next. */
const excalidrawFontCache = new Map<number, string>();

let automate: ReturnType<typeof createExcalidrawAutomateInstance> | undefined;

export async function fontFaceCssFor(app: App, stacks: Iterable<string>): Promise<string> {
	const families = new Set<string>();
	for (const stack of stacks) for (const family of fontFamiliesIn(stack)) families.add(family);

	const parts: string[] = [];
	for (const id of excalidrawFontIds(families)) parts.push(await excalidrawFontCss(app, id));
	const others = [...families].filter((family) => EXCALIDRAW_FONT_IDS[family] === undefined);
	parts.push(await stylesheetFontCss(others));
	return parts.filter((part) => part !== '').join('\n');
}

async function excalidrawFontCss(app: App, id: number): Promise<string> {
	const cached = excalidrawFontCache.get(id);
	if (cached !== undefined) return cached;
	if (automate === undefined || automate === null) automate = createExcalidrawAutomateInstance(app);
	if (automate === null) return '';

	let css = '';
	try {
		automate.reset();
		automate.style.fontFamily = id;
		automate.addText(0, 0, FONT_SAMPLE_TEXT);
		const svg = await automate.createSVG(undefined, true, undefined, undefined, 'light', 0);
		const styles = Array.from(svg.querySelectorAll('style')).map((style) => style.textContent ?? '');
		css = await inlineFonts(extractFontFaceRules(styles.join('\n')).join('\n'));
	} catch (error) {
		console.warn('[multi-exporter] Excalidraw font %d could not be embedded; it will print in a fallback font.', id, error);
	} finally {
		automate.reset();
	}
	if (css !== '') excalidrawFontCache.set(id, css);
	return css;
}

async function stylesheetFontCss(families: readonly string[]): Promise<string> {
	if (families.length === 0) return '';
	const wanted = new Set(families);
	const rules: string[] = [];
	for (const sheet of Array.from(activeDocument.styleSheets)) {
		let cssRules: CSSRuleList;
		try {
			cssRules = sheet.cssRules;
		} catch {
			continue; // A stylesheet whose rules cannot be read.
		}
		const base = sheet.href ?? activeDocument.baseURI;
		for (const rule of Array.from(cssRules)) {
			if (!rule.cssText.startsWith('@font-face')) continue;
			const family = fontFamiliesIn((rule as CSSFontFaceRule).style.getPropertyValue('font-family'))[0];
			if (family === undefined || !wanted.has(family)) continue;
			rules.push(absoluteUrls(rule.cssText, base));
		}
	}
	return rules.length === 0 ? '' : await inlineFonts(rules.join('\n'));
}

/** A rule's relative `url(...)`s resolved against its stylesheet, since the guest has no base. */
function absoluteUrls(css: string, base: string): string {
	return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (whole: string, _quote: string, url: string) => {
		if (url.startsWith('data:')) return whole;
		try {
			return `url("${new URL(url, base).href}")`;
		} catch {
			return whole;
		}
	});
}
