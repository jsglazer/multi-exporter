import { SNAPSHOT_PROPERTIES, pseudoContentText, serializeDeclarations } from '../core/style-snapshot';

/**
 * Writing the live app's computed styles onto a subtree as inline styles, so the subtree prints in
 * the isolated guest webview the way it looks in Obsidian. See `core/style-snapshot.ts` for why
 * this exists at all and which properties are copied.
 */

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

/**
 * Elements whose own descendants are left alone: their rendering is driven by a stylesheet that is
 * already carried into the guest separately (MathJax's), or is not CSS-box layout at all (SVG),
 * and freezing the resolved values of every glyph node would only fight it.
 */
const OPAQUE_TAGS = new Set(['svg', 'math', 'mjx-container']);

/** Elements that cannot hold a child, so a `::before`/`::after` stand-in has nowhere to go. */
const VOID_TAGS = new Set(['area', 'br', 'col', 'embed', 'hr', 'img', 'input', 'source', 'track', 'wbr']);

interface PseudoPlan {
	readonly text: string;
	readonly declarations: string;
	readonly block: boolean;
}

interface ElementPlan {
	readonly element: HTMLElement;
	readonly declarations: string;
	readonly before: PseudoPlan | null;
	readonly after: PseudoPlan | null;
}

/**
 * Freeze `root` and everything under it, returning every font family the frozen styles name.
 *
 * Every element is read before any is written: inserting a pseudo-element stand-in shifts
 * `:nth-child` matches and `:empty`, so interleaving reads and writes would freeze styles the
 * app never actually applied.
 */
export function freezeComputedStyles(root: HTMLElement): Set<string> {
	const view = root.ownerDocument.defaultView;
	const families = new Set<string>();
	if (view === null) return families;

	const plans: ElementPlan[] = [];
	for (const element of htmlElementsUnder(root)) {
		const computed = view.getComputedStyle(element);
		families.add(computed.getPropertyValue('font-family'));
		const canHoldChildren = !VOID_TAGS.has(element.tagName.toLowerCase());
		plans.push({
			element,
			declarations: declarationsOf(computed),
			before: canHoldChildren ? pseudoPlan(view.getComputedStyle(element, '::before')) : null,
			after: canHoldChildren ? pseudoPlan(view.getComputedStyle(element, '::after')) : null,
		});
	}

	for (const plan of plans) {
		// Appended after whatever the element already carried inline, so an inline style the
		// shell set on purpose (a fixed box height, `overflow: visible`) survives for every
		// property this does not copy, and agrees with it for every property it does.
		const existing = plan.element.getAttribute('style') ?? '';
		plan.element.setAttribute('style', `${existing} ${plan.declarations}`.trim());
		if (plan.before !== null) plan.element.prepend(standIn(plan.element, plan.before));
		if (plan.after !== null) plan.element.append(standIn(plan.element, plan.after));
	}
	return families;
}

function htmlElementsUnder(root: HTMLElement): HTMLElement[] {
	const found: HTMLElement[] = [];
	const visit = (element: Element): void => {
		if (element.namespaceURI !== XHTML_NAMESPACE) return;
		found.push(element as HTMLElement);
		if (OPAQUE_TAGS.has(element.tagName.toLowerCase())) return;
		for (const child of Array.from(element.children)) visit(child);
	};
	visit(root);
	return found;
}

function declarationsOf(computed: CSSStyleDeclaration): string {
	return serializeDeclarations(SNAPSHOT_PROPERTIES.map((name) => [name, computed.getPropertyValue(name)] as const));
}

function pseudoPlan(computed: CSSStyleDeclaration): PseudoPlan | null {
	const text = pseudoContentText(computed.getPropertyValue('content'));
	const display = computed.getPropertyValue('display');
	if (text === null || display === 'none') return null;
	return { text, declarations: declarationsOf(computed), block: display !== 'inline' };
}

function standIn(parent: HTMLElement, plan: PseudoPlan): HTMLElement {
	const element = parent.ownerDocument.createElement(plan.block ? 'div' : 'span');
	element.setAttribute('style', plan.declarations);
	element.setAttribute('aria-hidden', 'true');
	element.textContent = plan.text;
	return element;
}
