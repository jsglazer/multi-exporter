import { MarkdownRenderer, getFrontMatterInfo } from 'obsidian';
import type { App, Component, TFile } from 'obsidian';
import { getExcalidrawAutomate, getExcalidrawThemeVariables } from '../adapter/obsidian-internals';
import { cssPixels, isExcalidrawNote, nextBoxZoom, resolveEmbedLinkTarget } from '../core/excalidraw';
import { waitForDomStability } from './dom-stability';
import { fontFaceCssFor } from './excalidraw-fonts';
import { freezeComputedStyles } from './style-snapshot';

/**
 * Rendering an Excalidraw canvas note as a printable board.
 *
 * See `core/excalidraw.ts` for why a raw-markdown render cannot show one at all. Rather
 * than reconstruct the scene from its saved JSON — reimplementing Excalidraw's own layout,
 * colours and hand-drawn rendering — this asks Excalidraw's own public `ExcalidrawAutomate`
 * API for a real rendered SVG of the drawing, then modifies only the one thing that API
 * cannot draw: a box whose content is a live `obsidian://` iframe embed of another note. That
 * box's own border, fill and any other drawn artwork on the canvas come through unmodified,
 * exactly as Excalidraw rendered them.
 *
 * Box height is deliberately natural, not clipped: a swapped-in note's content is allowed to
 * grow taller than the canvas box it replaces, and the SVG's own height is grown to match
 * afterwards so paged.js's pagination sees the real size rather than treating the overflow as
 * invisible bleed. This does not reflow boxes *below* the one that grew, which is the one
 * known gap — every board in current use has enough vertical clearance that this has not
 * mattered, but a dense board could see two boxes overlap.
 *
 * A swapped-in note is styled to match the screen, not the export profile: it is rendered inside
 * the same canvas-file-node DOM Excalidraw hosts it in on the board, so the theme and any snippet
 * written against that DOM style it exactly as they do live, and those styles are then frozen
 * inline (`style-snapshot.ts`) and its fonts carried along (`excalidraw-fonts.ts`), because none
 * of the app's CSS exists in the guest webview.
 */

const PLACEHOLDER_CLASS = 'mx-excalidraw-placeholder';
const EMBED_CONTENT_CLASS = 'mx-excalidraw-embed-content';

interface SwappedBox {
	readonly foreignObject: SVGForeignObjectElement;
	readonly declaredHeight: number;
	/** The canvas-node scaffold a markdown note was rendered into; absent for a nested board or placeholder. */
	readonly canvasNode: CanvasNode | null;
}

/** The nested elements Obsidian's canvas file node — and so Excalidraw's embed — is built from. */
interface CanvasNode {
	readonly previewView: HTMLElement;
	readonly sizer: HTMLElement;
}

export async function renderExcalidrawBoard(
	app: App,
	file: TFile,
	container: HTMLElement,
	component: Component,
	ancestors: ReadonlySet<string>,
): Promise<void> {
	const automate = getExcalidrawAutomate(app);
	if (automate === null) {
		placeholder(container, 'The Excalidraw plugin is required to export this drawing, and is not enabled.');
		return;
	}

	let svg: SVGSVGElement;
	try {
		svg = await automate.createSVG(file.path, true, undefined, undefined, undefined, undefined, true);
	} catch (error) {
		placeholder(container, `This Excalidraw drawing could not be rendered: ${errorMessage(error)}`);
		return;
	}

	svg.setCssStyles({ overflow: 'visible' });
	container.appendChild(svg);

	const swapped: SwappedBox[] = [];
	const anchors = Array.from(svg.querySelectorAll<SVGAElement>('a'));

	for (const anchor of anchors) {
		const href = anchorHref(anchor);
		const foreignObject = anchor.querySelector<SVGForeignObjectElement>('foreignObject');
		if (href === null || foreignObject === null) continue;

		// `resolveEmbedLinkTarget` is the one place that decides which link shapes count as a
		// vault-note embed (obsidian:// URL or a bare wikilink) — deliberately not filtered
		// again here, so there is exactly one spot to update if Excalidraw ever renders a
		// third shape, instead of two that can silently drift apart the way they already have
		// once (see its own doc comment and tests in core/excalidraw.ts).
		const linkTarget = resolveEmbedLinkTarget(href);
		if (linkTarget === null) continue; // Not a vault-note embed — leave Excalidraw's own rendering as-is.

		const declaredHeight = foreignObjectSize(foreignObject).height;
		const outcome = await renderEmbedBox(app, file, linkTarget, foreignObject, component, ancestors);
		if (outcome === false) continue;
		hideLinkLabel(anchor);
		swapped.push({ foreignObject, declaredHeight, canvasNode: outcome === true ? null : outcome });
	}

	if (swapped.length === 0) return;
	await waitForDomStability(container);

	const themeVariables = getExcalidrawThemeVariables(app, file.path);
	const fontStacks = new Set<string>();
	for (const box of swapped) {
		if (box.canvasNode === null) continue;
		wrapReadingSections(box.canvasNode.sizer);
		shrinkToFit(box.canvasNode, box.declaredHeight);
		const wrapper = box.foreignObject.firstElementChild as HTMLElement | null;
		if (wrapper === null) continue;
		// Excalidraw's canvas palette, applied only for the freeze: the frozen styles carry the
		// resolved colours, so the variables themselves are removed again rather than shipped
		// to the guest, where nothing reads them.
		wrapper.setCssProps(themeVariables);
		for (const stack of freezeComputedStyles(wrapper)) fontStacks.add(stack);
		for (const name of Object.keys(themeVariables)) wrapper.style.removeProperty(name);
	}
	growToFitOverflow(svg, swapped);
	if (fontStacks.size > 0) addStyleToSvg(svg, await fontFaceCssFor(app, fontStacks));
}

/**
 * Replace one embeddable box's content with the note it links to, or an explanatory
 * placeholder when that cannot be done. Returns the canvas-node scaffold when a markdown note
 * was rendered (so the caller can freeze its styles), `true` for any other swap, and `false`
 * when nothing was swapped — the caller hides the box's raw-URL label on anything but `false`.
 */
async function renderEmbedBox(
	app: App,
	file: TFile,
	linkTarget: string,
	foreignObject: SVGForeignObjectElement,
	component: Component,
	ancestors: ReadonlySet<string>,
): Promise<CanvasNode | boolean> {
	const target = app.metadataCache.getFirstLinkpathDest(linkTarget, file.path);
	if (target === null) {
		replaceForeignObjectContent(foreignObject, (wrapper) => placeholder(wrapper, `Missing note: ${linkTarget}`));
		return true;
	}
	if (ancestors.has(target.path)) {
		replaceForeignObjectContent(foreignObject, (wrapper) =>
			placeholder(wrapper, `Circular embed skipped: ${linkTarget}`),
		);
		return true;
	}

	const nextAncestors = new Set(ancestors);
	nextAncestors.add(target.path);
	const targetFrontmatter = app.metadataCache.getFileCache(target)?.frontmatter;

	if (isExcalidrawNote(target.path, targetFrontmatter)) {
		const wrapper = replaceForeignObjectContent(foreignObject, () => undefined);
		await renderExcalidrawBoard(app, target, wrapper, component, nextAncestors);
		return true;
	}

	// A canvas file node never shows a note's frontmatter; rendering it here would put a hidden
	// block first in the sizer and shift which element the reading view's first-child rules hit.
	const source = await app.vault.cachedRead(target);
	const targetMarkdown = source.slice(getFrontMatterInfo(source).contentStart);
	const wrapper = replaceForeignObjectContent(foreignObject, () => undefined);
	const node = buildCanvasNode(wrapper, foreignObject);
	await MarkdownRenderer.render(app, targetMarkdown, node.sizer, target.path, component);
	return node;
}

/**
 * The DOM Obsidian's canvas file node renders a note into, which is what Excalidraw mounts in an
 * embeddable box on screen: `.canvas-node-container > .canvas-node-content.markdown-embed >
 * .markdown-embed-content > .markdown-preview-view.markdown-rendered > .markdown-preview-sizer`.
 * Matching it is what makes a snippet like `.canvas-node-container .markdown-rendered h2 { ... }`
 * apply here the way it does on the board.
 *
 * Three things differ on purpose. The box's own border and fill are left to Excalidraw's drawn
 * rectangle underneath (a second, CSS border would double it). `overflow` is visible rather than
 * clipped, so a font that measures a pixel wider in print costs a wrapped line, not lost text. And
 * `theme-light` is set on the wrapper, because the PDF is printed on white paper whatever theme
 * Obsidian is in.
 */
function buildCanvasNode(wrapper: HTMLElement, foreignObject: SVGForeignObjectElement): CanvasNode {
	const { width, height } = foreignObjectSize(foreignObject);
	wrapper.classList.add('theme-light');

	const container = wrapper.createDiv({ cls: 'canvas-node-container' });
	container.setCssStyles({
		width: `${width}px`,
		height: `${height}px`,
		backgroundColor: 'transparent',
		border: 'none',
		borderRadius: '0',
		boxShadow: 'none',
		contain: 'none',
		overflow: 'visible',
	});
	container.setCssProps({ '--canvas-node-height': `${height}px` });
	const content = container.createDiv({ cls: 'canvas-node-content markdown-embed' });
	const embedContent = content.createDiv({ cls: 'markdown-embed-content' });
	const previewView = embedContent.createDiv({ cls: 'markdown-preview-view markdown-rendered' });
	const sizer = previewView.createDiv({ cls: 'markdown-preview-sizer markdown-preview-section' });
	for (const level of [content, embedContent, previewView]) level.setCssStyles({ height: '100%', overflow: 'visible' });
	return { previewView, sizer };
}

/**
 * Give rendered markdown the section structure Obsidian's reading view gives it.
 *
 * `MarkdownRenderer.render` appends bare blocks (`<p>`, `<ul>`, ...). The reading view — and so a
 * canvas file node on the board — puts a `.markdown-preview-pusher` first in the sizer and wraps
 * every block in a `div.el-<tag>` section (see `"el-"+firstChild.tagName` in Obsidian's `app.js`).
 * `app.css` spaces notes through that structure: `.markdown-preview-pusher + div > :first-child`
 * and `div:last-child > :last-child` drop the outer margins of the first and last block. Without
 * it, a note whose first line is a paragraph (a `**Title**` line, say) keeps a full paragraph
 * margin above it that the board never shows, and every box's content sits lower than on screen.
 */
function wrapReadingSections(sizer: HTMLElement): void {
	if (sizer.querySelector(':scope > .markdown-preview-pusher') !== null) return;
	for (const child of Array.from(sizer.children)) {
		if (/(^|\s)el-/.test(child.className)) continue;
		const section = activeDocument.createElement('div');
		section.className = `el-${child.tagName.toLowerCase()}`;
		sizer.insertBefore(section, child);
		section.appendChild(child);
	}
	const pusher = activeDocument.createElement('div');
	pusher.className = 'markdown-preview-pusher';
	pusher.setCssStyles({ width: '1px', height: '0.1px' });
	sizer.prepend(pusher);
}

/**
 * Keep a note inside its box, the way the board does.
 *
 * On screen a note taller than its box scrolls inside the box's border; nothing ever spills past
 * it. Paper cannot scroll, and neither of the obvious substitutes is a replica: growing the box
 * runs text across Excalidraw's drawn border (which stays the canvas size), and clipping silently
 * loses lines. So an overflowing note is laid out smaller — `zoom` on the sizer, which reflows
 * rather than just scaling a picture — until it fits. A note that already fits is untouched.
 */
function shrinkToFit(node: CanvasNode, boxHeight: number): void {
	let zoom = 1;
	for (let attempt = 0; attempt < 6; attempt++) {
		const next = nextBoxZoom(zoom, neededHeight(node), boxHeight);
		if (next === null) return;
		zoom = next;
		node.sizer.setCssProps({ zoom: String(zoom) });
	}
}

/**
 * The height a box's content really needs: from the top of the box to the bottom of the note's
 * last block, plus whatever the box keeps below it (the bottom centring spacer's minimum and the
 * view's bottom padding).
 *
 * Not `scrollHeight`. The sizer is `flex: 1 0 0` — it grows to fill the box — and the two centring
 * spacers keep a minimum height on top of that, so `scrollHeight` reports a few pixels of overflow
 * for every box, including one whose note is half its height (on screen that is a scrollable sliver
 * of empty space nobody sees). Shrinking on it shrank every note on the board.
 */
function neededHeight(node: CanvasNode): number {
	const view = node.previewView;
	const window = view.ownerDocument.defaultView;
	const last = node.sizer.lastElementChild;
	if (window === null || last === null) return 0;
	const lastMarginBottom = parseFloat(window.getComputedStyle(last).marginBottom) || 0;
	const contentBottom = last.getBoundingClientRect().bottom + lastMarginBottom;
	const below =
		(parseFloat(window.getComputedStyle(view, '::after').minHeight) || 0) +
		(parseFloat(window.getComputedStyle(view).paddingBottom) || 0);
	return contentBottom - view.getBoundingClientRect().top + below;
}

/**
 * A note-embed box's size in drawing units.
 *
 * Excalidraw does not size an embed's `<foreignObject>` with `width`/`height` attributes; it writes
 * `style="width: 400px; height: 420px"` (see any SVG it exports). Reading only the attributes gave
 * every box a size of 0 — which collapsed every embedded note to one letter per line the moment
 * the box's width was actually used (1.0.39), and before that silently made the grow-to-fit step
 * add each note's whole height as extra space. Attributes are still honoured first, in case a
 * later Excalidraw writes them.
 */
function foreignObjectSize(foreignObject: SVGForeignObjectElement): { width: number; height: number } {
	return {
		width: cssPixels(foreignObject.getAttribute('width')) ?? cssPixels(foreignObject.style.width) ?? 0,
		height: cssPixels(foreignObject.getAttribute('height')) ?? cssPixels(foreignObject.style.height) ?? 0,
	};
}

/** Append CSS to the drawing's own `<defs>`, where Excalidraw's export keeps its embedded fonts. */
function addStyleToSvg(svg: SVGSVGElement, css: string): void {
	if (css === '') return;
	const namespace = 'http://www.w3.org/2000/svg';
	let defs = svg.querySelector('defs');
	if (defs === null) {
		defs = activeDocument.createElementNS(namespace, 'defs');
		svg.prepend(defs);
	}
	const style = activeDocument.createElementNS(namespace, 'style');
	style.textContent = css;
	defs.appendChild(style);
}

/** Empty a foreignObject and give it a fresh, unclipped HTML wrapper for `fill` to populate. */
function replaceForeignObjectContent(
	foreignObject: SVGForeignObjectElement,
	fill: (wrapper: HTMLElement) => void,
): HTMLElement {
	while (foreignObject.firstChild !== null) foreignObject.removeChild(foreignObject.firstChild);
	foreignObject.setCssStyles({ overflow: 'visible' });
	const wrapper = activeDocument.createElement('div');
	wrapper.className = EMBED_CONTENT_CLASS;
	foreignObject.appendChild(wrapper);
	fill(wrapper);
	return wrapper;
}

/**
 * The `<g>` sibling Excalidraw draws next to the foreignObject, showing the raw `obsidian://`
 * URL as text — redundant once real content is in the box, so it is hidden rather than
 * relied on. Left alone (not queried at all) when a box was not swapped, so a genuinely
 * unresolvable embed still shows Excalidraw's own best-effort label.
 */
function hideLinkLabel(anchor: SVGAElement): void {
	for (const child of Array.from(anchor.children)) {
		if (child.tagName.toLowerCase() !== 'g') continue;
		if (child.querySelector('foreignObject') !== null) continue;
		if (child.querySelector('text') !== null) (child as SVGElement).setCssStyles({ display: 'none' });
	}
}

/**
 * Grow the SVG's declared height (and viewBox) to include any box that rendered taller than
 * its original canvas size, so paged.js's pagination measures the drawing's real height
 * instead of a size that no longer matches what is visibly drawn.
 */
function growToFitOverflow(svg: SVGSVGElement, swapped: readonly SwappedBox[]): void {
	let maxOverflow = 0;
	for (const box of swapped) {
		const contentHeight = box.foreignObject.firstElementChild?.getBoundingClientRect().height ?? 0;
		maxOverflow = Math.max(maxOverflow, contentHeight - box.declaredHeight);
	}
	if (maxOverflow <= 0) return;

	const currentHeight = parseFloat(svg.getAttribute('height') ?? '0');
	if (currentHeight > 0) svg.setAttribute('height', `${currentHeight + maxOverflow}`);

	const viewBox = svg.getAttribute('viewBox');
	const parts = viewBox?.split(/\s+/).map(Number) ?? [];
	if (parts.length === 4) {
		const [minX, minY, width, height] = parts as [number, number, number, number];
		svg.setAttribute('viewBox', `${minX} ${minY} ${width} ${height + maxOverflow}`);
	}
}

/** An SVG `<a>`'s link, whichever attribute form rendered it (plain `href` or `xlink:href`). */
function anchorHref(anchor: SVGAElement): string | null {
	return anchor.getAttribute('href') ?? anchor.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
}

function placeholder(container: HTMLElement, text: string): void {
	const el = activeDocument.createElement('p');
	el.className = PLACEHOLDER_CLASS;
	el.textContent = text;
	container.appendChild(el);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
