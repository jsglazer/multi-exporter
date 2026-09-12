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

/** Obsidian writes this into every note the Excalidraw plugin owns. */
export function isExcalidrawNote(frontmatter: Record<string, unknown> | undefined): boolean {
	return frontmatter?.['excalidraw-plugin'] === 'parsed' || frontmatter?.['excalidraw-plugin'] === 'raw';
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
