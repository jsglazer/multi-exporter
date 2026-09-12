import { MarkdownRenderer } from 'obsidian';
import type { App, Component, TFile } from 'obsidian';
import { getExcalidrawAutomate } from '../adapter/obsidian-internals';
import { isExcalidrawNote, resolveEmbedLinkTarget } from '../core/excalidraw';
import { waitForDomStability } from './dom-stability';

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
 */

const PLACEHOLDER_CLASS = 'mx-excalidraw-placeholder';
const EMBED_CONTENT_CLASS = 'mx-excalidraw-embed-content';

interface SwappedBox {
	readonly foreignObject: SVGForeignObjectElement;
	readonly declaredHeight: number;
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
		svg = await automate.createSVG(file.path, true);
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

		const linkTarget = resolveEmbedLinkTarget(href);
		if (linkTarget === null) continue; // Not a vault-note embed — leave Excalidraw's own rendering as-is.

		const outcome = await renderEmbedBox(app, file, linkTarget, foreignObject, component, ancestors);
		if (!outcome) continue;
		hideLinkLabel(anchor);
		swapped.push({ foreignObject, declaredHeight: parseFloat(foreignObject.getAttribute('height') ?? '0') });
	}

	if (swapped.length > 0) {
		await waitForDomStability(container);
		growToFitOverflow(svg, swapped);
	}
}

/**
 * Replace one embeddable box's content with the note it links to, or an explanatory
 * placeholder when that cannot be done. Returns whether anything was swapped in, so the
 * caller knows whether to also hide the box's raw-URL label.
 */
async function renderEmbedBox(
	app: App,
	file: TFile,
	linkTarget: string,
	foreignObject: SVGForeignObjectElement,
	component: Component,
	ancestors: ReadonlySet<string>,
): Promise<boolean> {
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

	if (isExcalidrawNote(targetFrontmatter)) {
		const wrapper = replaceForeignObjectContent(foreignObject, () => undefined);
		await renderExcalidrawBoard(app, target, wrapper, component, nextAncestors);
		return true;
	}

	const targetMarkdown = await app.vault.cachedRead(target);
	const wrapper = replaceForeignObjectContent(foreignObject, () => undefined);
	await MarkdownRenderer.render(app, targetMarkdown, wrapper, target.path, component);
	return true;
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
	const href = anchor.getAttribute('href') ?? anchor.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
	return href !== null && href.startsWith('obsidian://') ? href : null;
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
