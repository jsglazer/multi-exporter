import { SNAPSHOT_PROPERTIES, pseudoContentText, serializeDeclarations } from '../core/style-snapshot';

/**
 * Writing the live app's computed styles onto a subtree as inline styles, so the subtree prints in
 * the isolated guest webview the way it looks in Obsidian. See `core/style-snapshot.ts` for why
 * this exists at all and which properties are copied.
 */

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

/**
 * Elements whose descendants get only `LIMITED_PROPERTIES` frozen. MathJax's generated stylesheet
 * travels into the guest separately and lays out every glyph box from TeX metrics; freezing the
 * resolved box model of each glyph node would fight it. But a snippet that sets `font-family` on
 * `*` (as an Excalidraw embed snippet typically does) reaches MathJax's glyph elements on screen,
 * so digits in `$0.32 > 1$` draw in Virgil there — and without the font frozen they fall back to
 * MathJax's own font in print.
 */
const MATH_TAGS = new Set(['mjx-container']);

/** What is frozen inside `MATH_TAGS`: how glyphs are drawn, never how they are laid out. */
const LIMITED_PROPERTIES: readonly string[] = ['font-family', 'color'];

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
	for (const { element, limited } of htmlElementsUnder(root)) {
		const computed = view.getComputedStyle(element);
		families.add(computed.getPropertyValue('font-family'));
		// MathJax draws each glyph as a `::before`, so a stand-in would duplicate it.
		const canHoldChildren = !limited && !VOID_TAGS.has(element.tagName.toLowerCase());
		plans.push({
			element,
			declarations: declarationsOf(computed, limited ? LIMITED_PROPERTIES : SNAPSHOT_PROPERTIES),
			before: canHoldChildren ? pseudoPlan(view.getComputedStyle(element, '::before')) : null,
			after: canHoldChildren ? pseudoPlan(view.getComputedStyle(element, '::after')) : null,
		});
	}

	for (const plan of plans) {
		// Appended after whatever the element already carried inline, so an inline style the
		// shell set on purpose (a fixed box height, `overflow: visible`) survives for every
		// property this does not copy, and agrees with it for every property it does.
		// Joined with an explicit `;`: an inline style whose last declaration has no trailing
		// semicolon would otherwise swallow the first frozen declaration into its value.
		const existing = (plan.element.getAttribute('style') ?? '').trim();
		const separator = existing === '' || existing.endsWith(';') ? ' ' : '; ';
		plan.element.setAttribute('style', `${existing}${separator}${plan.declarations}`.trim());
		if (plan.before !== null) plan.element.prepend(standIn(plan.element, plan.before));
		if (plan.after !== null) plan.element.append(standIn(plan.element, plan.after));
	}
	return families;
}

/**
 * Every HTML element under `root`, each flagged `limited` when it sits inside a `MATH_TAGS`
 * element. SVG (and MathML) subtrees are skipped outright: not CSS-box layout.
 */
function htmlElementsUnder(root: HTMLElement): { element: HTMLElement; limited: boolean }[] {
	const found: { element: HTMLElement; limited: boolean }[] = [];
	const visit = (element: Element, limited: boolean): void => {
		if (element.namespaceURI !== XHTML_NAMESPACE) return;
		found.push({ element: element as HTMLElement, limited });
		const inMath = limited || MATH_TAGS.has(element.tagName.toLowerCase());
		for (const child of Array.from(element.children)) visit(child, inMath);
	};
	visit(root, false);
	return found;
}

function declarationsOf(computed: CSSStyleDeclaration, properties: readonly string[] = SNAPSHOT_PROPERTIES): string {
	return serializeDeclarations(properties.map((name) => [name, computed.getPropertyValue(name)] as const));
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
