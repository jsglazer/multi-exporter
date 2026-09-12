import { decompressFromBase64 } from 'lz-string';

/**
 * Turning an Excalidraw canvas note into a printable board.
 *
 * An `.excalidraw.md` file is not a document, it is a save format: the Excalidraw plugin
 * stores its scene as `lz-string`-compressed JSON inside a `%%...%%` Obsidian comment, which
 * is invisible to `MarkdownRenderer` by design. Rendering the raw markdown, as every other
 * note does, produces only the plugin's own scaffold text — a warning banner and a list of
 * plain `[[wikilinks]]` — never the canvas itself.
 *
 * The canvases actually in use here are boards of "embeddable" elements: rectangles whose
 * content is a live `obsidian://` iframe to another note, not hand-drawn artwork. No static
 * export can rasterise a live iframe, so the board's only faithful printed form is to lay out
 * each box at its own position and render the *linked note's own content* inside it — which
 * is what this module computes, in DOM-free coordinates the shell then turns into HTML.
 */

/** One element of an Excalidraw scene, trimmed to the fields this module reads. */
export interface ExcalidrawElement {
	readonly id: string;
	readonly type: string;
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
	readonly link?: string | null;
	readonly isDeleted?: boolean;
}

export interface ExcalidrawScene {
	readonly elements: readonly ExcalidrawElement[];
}

/** One positioned box on the printed board, relative to the board's own top-left corner. */
export interface BoardBox {
	readonly id: string;
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
	/** The vault link text this box embeds (e.g. `CurveShifts` from `[[CurveShifts]]`), or `null` if it isn't a note embed. */
	readonly linkTarget: string | null;
}

export interface BoardLayout {
	readonly width: number;
	readonly height: number;
	readonly boxes: readonly BoardBox[];
}

/** Obsidian writes this into every note the Excalidraw plugin owns. */
export function isExcalidrawNote(frontmatter: Record<string, unknown> | undefined): boolean {
	return frontmatter?.['excalidraw-plugin'] === 'parsed' || frontmatter?.['excalidraw-plugin'] === 'raw';
}

/**
 * Pull the scene payload out of the note's raw markdown.
 *
 * The plugin fences it as either `compressed-json` (the default, `lz-string`-compressed) or
 * plain `json` (when the user has turned compression off in its settings) — both are just a
 * fenced code block, comment syntax around it notwithstanding, so one regex covers both.
 */
export function extractSceneSource(markdown: string): { compressed: boolean; body: string } | null {
	const match = /```(compressed-json|json)\r?\n([\s\S]*?)```/.exec(markdown);
	if (match === null) return null;
	const kind = match[1];
	const body = match[2] ?? '';
	return { compressed: kind === 'compressed-json', body: body.trim() };
}

/**
 * Turn the fenced payload into a scene.
 *
 * `lz-string`'s base64 alphabet has no whitespace of its own, so a compressed blob wrapped
 * across many lines in the markdown file decompresses to garbage unless every line break is
 * stripped first — decompressing without doing so does not throw, it just produces truncated
 * or corrupt JSON partway through, which is worse than a clean failure.
 */
export function parseExcalidrawScene(source: { compressed: boolean; body: string }): ExcalidrawScene {
	const json = source.compressed ? decompressFromBase64(source.body.replace(/\s+/g, '')) : source.body;
	if (json === null || json === '') {
		throw new Error('Excalidraw scene data could not be decompressed.');
	}
	const parsed: unknown = JSON.parse(json);
	if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { elements?: unknown }).elements)) {
		throw new Error('Excalidraw scene JSON did not have the expected shape.');
	}
	return { elements: (parsed as { elements: ExcalidrawElement[] }).elements };
}

/**
 * A wikilink embed target, e.g. `[[CurveShifts]]` -> `CurveShifts`, `[[Note|Alias]]` -> `Note`.
 *
 * Excalidraw also accepts a raw `obsidian://open?...&file=...` URL for an embed created by
 * dragging a note in rather than typing a link; that form carries no benefit over the
 * wikilink here (both resolve through the same vault lookup) so it is decoded to the same
 * shape rather than treated as a second case the caller has to branch on.
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

/**
 * The board's bounding box and each embeddable element's position within it.
 *
 * Only `embeddable` elements are placed — Excalidraw's other element types (freehand strokes,
 * shapes, bound text) are real drawn artwork with no vault note behind them, and every board
 * in current use here has none, so rendering them is left for when one actually exists rather
 * than guessed at now. Rotation is ignored: an axis-aligned box is trivially correct and every
 * observed board is axis-aligned; a rotated board would print with straightened boxes rather
 * than crash.
 */
export function computeBoardLayout(scene: ExcalidrawScene): BoardLayout {
	const embeddables = scene.elements.filter((element) => element.isDeleted !== true && element.type === 'embeddable');
	if (embeddables.length === 0) return { width: 0, height: 0, boxes: [] };

	const minX = Math.min(...embeddables.map((element) => element.x));
	const minY = Math.min(...embeddables.map((element) => element.y));
	const maxX = Math.max(...embeddables.map((element) => element.x + element.width));
	const maxY = Math.max(...embeddables.map((element) => element.y + element.height));

	const boxes = embeddables.map((element) => ({
		id: element.id,
		x: element.x - minX,
		y: element.y - minY,
		width: element.width,
		height: element.height,
		linkTarget: resolveEmbedLinkTarget(element.link),
	}));

	return { width: maxX - minX, height: maxY - minY, boxes };
}
