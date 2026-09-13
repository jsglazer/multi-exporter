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
