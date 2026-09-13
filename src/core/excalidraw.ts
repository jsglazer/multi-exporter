/**
 * Recognising an Excalidraw canvas note and its embed links.
 *
 * An `.excalidraw.md` file's own markdown is a save-format scaffold — a warning banner and
 * the scene as `lz-string`-compressed JSON inside a `%%...%%` Obsidian comment — never the
 * canvas itself, so `MarkdownRenderer` cannot render one. The shell instead asks the
 * Excalidraw plugin's own public `ExcalidrawAutomate.createSVG` API to render the real
 * scene (colours, shapes, hand-drawn strokes, everything) and only intervenes on the one
 * thing that API cannot draw: a box whose content is a live `obsidian://` iframe embed of
 * another note, which no static renderer can rasterise. This module has the two pure,
 * DOM-free pieces of that: detecting the note type, and reading a vault link back out of
 * the `obsidian://` URL (or wikilink) Excalidraw put on such a box.
 */

/**
 * Whether a note belongs to the Excalidraw plugin, mirrored exactly from its own
 * `isExcalidrawFile` (extracted from the shipped `main.js`, since this is not part of its
 * published API): a legacy raw `.excalidraw` file, or any *truthy* `excalidraw-plugin`
 * frontmatter value — not a specific string. The `.excalidraw.md` filename check is not just
 * a faster path than the frontmatter one; a canvas whose frontmatter has an unusual shape
 * (e.g. Excalidraw's own writer puts a blank line before the first key, and this plugin's
 * `.excalidraw.md` boards all have one) still needs to be found some way, and the filename
 * always tells the truth about a file this plugin created.
 */
export function isExcalidrawNote(path: string, frontmatter: Record<string, unknown> | undefined): boolean {
	if (path.endsWith('.excalidraw.md') || path.endsWith('.excalidraw')) return true;
	return Boolean(frontmatter?.['excalidraw-plugin']);
}

/**
 * Excalidraw's built-in font families by the numeric id its scene elements and
 * `ExcalidrawAutomate.style.fontFamily` use, mirrored from the plugin's own markdown-embed font
 * switch in `main.js` (`case"Virgil":getCSSFontDefinition(1)` ...). `Helvetica` is id 2 there too,
 * but it is a system font the guest already has, so it is not listed.
 */
export const EXCALIDRAW_FONT_IDS: Readonly<Record<string, number>> = {
	Virgil: 1,
	Cascadia: 3,
	Excalifont: 5,
	Nunito: 6,
	'Lilita One': 7,
	'Comic Shanns': 8,
	'Liberation Sans': 9,
};

/** The Excalidraw font ids among a set of family names, each once, in ascending order. */
export function excalidrawFontIds(families: Iterable<string>): number[] {
	const ids = new Set<number>();
	for (const family of families) {
		const id = EXCALIDRAW_FONT_IDS[family];
		if (id !== undefined) ids.add(id);
	}
	return [...ids].sort((a, b) => a - b);
}

/**
 * The text drawn in each font when asking Excalidraw to embed it.
 *
 * Excalidraw's SVG export may subset an embedded font to the glyphs the scene actually uses, so
 * the sample has to cover whatever a note is likely to contain: printable ASCII, Latin-1, and the
 * typographic and arrow characters notes commonly use. A character outside it falls back to the
 * next family in the stack rather than disappearing.
 */
export const FONT_SAMPLE_TEXT = (() => {
	let text = '';
	for (let code = 0x20; code <= 0x7e; code++) text += String.fromCharCode(code);
	for (let code = 0xa1; code <= 0xff; code++) text += String.fromCharCode(code);
	return `${text}‘’“”–—…•·−×÷±≤≥≠≈°€£™→←↑↓⇒⇐⇔`;
})();

/**
 * A positive length in CSS pixels from an SVG attribute or inline style value (`"420"`, `"420px"`),
 * or `null` when there is none — so a caller can fall through attribute -> style without treating
 * a missing value as a zero-sized box.
 */
export function cssPixels(value: string | null | undefined): number | null {
	if (value === null || value === undefined) return null;
	const match = /^\s*(\d+(?:\.\d+)?)(px)?\s*$/.exec(value);
	if (match === null) return null;
	const pixels = Number(match[1]);
	return pixels > 0 ? pixels : null;
}

/**
 * Which note an "export the active note" command means.
 *
 * Clicking into a note embedded on an Excalidraw board opens a real editor for that note inside
 * the board, and Excalidraw calls `workspace.setActiveLeaf` on it — so `getActiveFile()` then
 * names the embedded note (e.g. `Elasticity.md`), not the board the user is looking at. Exporting
 * that exports one box of the canvas as a lone note. `enclosingBoards` is every Excalidraw board
 * whose view contains the active view, innermost first; the outermost one is the canvas actually
 * open in the tab, and wins. No enclosing board means the active file is what it says it is.
 */
export function resolveExportTarget<T>(activeFile: T | null, enclosingBoards: readonly T[]): T | null {
	return enclosingBoards[enclosingBoards.length - 1] ?? activeFile;
}

/**
 * A note-embed box's link target, e.g. `[[CurveShifts]]` -> `CurveShifts`, or the
 * `obsidian://open?...&file=...` URL Excalidraw renders such a box's link as -> the decoded
 * vault path.
 *
 * Excalidraw accepts a wikilink typed directly into the embed dialog as well as the URL a
 * dragged-in note produces; both resolve through the same vault lookup, so both are decoded
 * to the same shape rather than making the caller branch on which one it got.
 */
export function resolveEmbedLinkTarget(link: string | null | undefined): string | null {
	if (link === null || link === undefined || link === '') return null;
	const wikilink = /^\[\[([^\]|#]+)/.exec(link);
	if (wikilink !== null) return wikilink[1]?.trim() ?? null;
	try {
		const url = new URL(link);
		if (url.protocol !== 'obsidian:') return null;
		const file = url.searchParams.get('file');
		return file === null ? null : decodeURIComponent(file).replace(/\.md$/, '');
	} catch {
		return null;
	}
}
