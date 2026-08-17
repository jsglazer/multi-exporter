import { toArray } from './dom';
import type { ElementLike } from './dom';

/**
 * PDF bookmarks, built from paged.js's page map.
 *
 * paged.js reports which page each element landed on, so the outline is a walk over the
 * headings in page order — no sentinel-URI round trip, no second render pass. Everything
 * here is a pure function of the walked headings, so it is tested against a mock page flow
 * rather than a real paginator.
 */

export const DEFAULT_HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6';

export interface HeadingRef {
	/** 1–6, as in `h1`–`h6`. */
	level: number;
	title: string;
	/** Zero-based index of the page the heading landed on. */
	pageIndex: number;
}

export interface OutlineNode {
	title: string;
	pageIndex: number;
	children: OutlineNode[];
}

/** One page as reported by the paginator: its index plus its rendered content root. */
export interface PagedPage {
	pageIndex: number;
	element: ElementLike;
}

/**
 * Walk a page flow and collect its headings in page order.
 *
 * This is the seam the deterministic tests drive: a mock page-flow walker supplies pages
 * whose `element.querySelectorAll` returns hand-built heading stubs, and the real backend
 * supplies paged.js's `.pagedjs_page` elements. Headings with no text are dropped — an
 * empty bookmark is worse than a missing one.
 */
export function collectHeadingRefs(
	pages: ArrayLike<PagedPage>,
	selector: string = DEFAULT_HEADING_SELECTOR,
): HeadingRef[] {
	const refs: HeadingRef[] = [];
	for (const page of toArray(pages)) {
		for (const element of toArray(page.element.querySelectorAll(selector))) {
			const level = headingLevel(element);
			if (level === null) continue;
			const title = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
			if (title === '') continue;
			refs.push({ level, title, pageIndex: page.pageIndex });
		}
	}
	return refs;
}

function headingLevel(element: ElementLike): number | null {
	const explicit = element.getAttribute('data-outline-level');
	if (explicit !== null) {
		const parsed = Number.parseInt(explicit, 10);
		if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 6) return parsed;
	}
	const match = /^h([1-6])$/.exec(element.nodeName.toLowerCase());
	return match === null ? null : Number.parseInt(match[1] ?? '', 10);
}

/**
 * Nest a flat heading list into an outline tree.
 *
 * Real documents skip levels (an `h1` followed by an `h3`) and start deep (a note whose
 * first heading is an `h2`). Both are handled by nesting relative to the current stack
 * rather than by absolute level, so no heading is ever dropped and the tree depth follows
 * the document rather than the tag numbers.
 */
export function buildOutline(headings: readonly HeadingRef[]): OutlineNode[] {
	const roots: OutlineNode[] = [];
	const stack: { level: number; node: OutlineNode }[] = [];

	for (const heading of headings) {
		const node: OutlineNode = { title: heading.title, pageIndex: heading.pageIndex, children: [] };
		while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= heading.level) {
			stack.pop();
		}
		const parent = stack[stack.length - 1];
		if (parent === undefined) {
			roots.push(node);
		} else {
			parent.node.children.push(node);
		}
		stack.push({ level: heading.level, node });
	}

	return roots;
}

/**
 * Prefix each document's headings with a top-level entry for the document itself and shift
 * every level down one, so a merged export gets one bookmark per note with its own headings
 * nested beneath. Page indices are already continuous — merged mode paginates once.
 */
export function mergeDocumentOutlines(
	documents: readonly { title: string; startPageIndex: number; headings: readonly HeadingRef[] }[],
): OutlineNode[] {
	const flattened: HeadingRef[] = [];
	for (const doc of documents) {
		flattened.push({ level: 1, title: doc.title, pageIndex: doc.startPageIndex });
		for (const heading of doc.headings) {
			flattened.push({ ...heading, level: Math.min(heading.level + 1, 7) });
		}
	}
	return buildOutline(flattened);
}

/** Total nodes in an outline tree. Used by the export report. */
export function countOutlineNodes(nodes: readonly OutlineNode[]): number {
	return nodes.reduce((total, node) => total + 1 + countOutlineNodes(node.children), 0);
}
