/**
 * Minimal structural DOM surface used by `src/core/`.
 *
 * Core never imports `obsidian`, node `fs`, or the real DOM lib. It works against these
 * interfaces instead, so every core function is reachable from a headless test with a
 * hand-built mock tree (see `tests/fakes/mock-dom.ts`). Real `Element`/`Document` objects
 * satisfy these structurally, so the shell passes them straight through.
 */

export const NODE_TYPE_ELEMENT = 1;
export const NODE_TYPE_TEXT = 3;

export interface NodeLike {
	readonly nodeType: number;
	readonly nodeName: string;
	readonly textContent: string | null;
	readonly childNodes: ArrayLike<NodeLike>;
}

export interface ClassListLike {
	contains(token: string): boolean;
}

export interface ElementLike extends NodeLike {
	readonly classList: ClassListLike;
	getAttribute(name: string): string | null;
	querySelectorAll(selector: string): ArrayLike<ElementLike>;
}

export interface RootLike {
	querySelectorAll(selector: string): ArrayLike<ElementLike>;
}

/** `ArrayLike` -> array, without depending on iterability (NodeList vs. plain array). */
export function toArray<T>(list: ArrayLike<T>): T[] {
	const out: T[] = [];
	for (let i = 0; i < list.length; i++) {
		const item = list[i];
		if (item !== undefined) out.push(item);
	}
	return out;
}

export function isElement(node: NodeLike): node is ElementLike {
	return node.nodeType === NODE_TYPE_ELEMENT;
}

export function isText(node: NodeLike): boolean {
	return node.nodeType === NODE_TYPE_TEXT;
}

/** Lowercased tag name, so callers never have to care about `DIV` vs `div`. */
export function tagName(node: NodeLike): string {
	return node.nodeName.toLowerCase();
}

/**
 * Depth-first walk over text nodes, skipping the subtree of any element whose tag is in
 * `skipTags`. Used by the opt-in Pandoc-style citation scan, which must not read code.
 */
export function walkTextNodes(
	root: NodeLike,
	skipTags: ReadonlySet<string>,
	visit: (node: NodeLike) => void,
): void {
	const children = toArray(root.childNodes);
	for (const child of children) {
		if (isText(child)) {
			visit(child);
			continue;
		}
		if (child.nodeType !== NODE_TYPE_ELEMENT) continue;
		if (skipTags.has(tagName(child))) continue;
		walkTextNodes(child, skipTags, visit);
	}
}
