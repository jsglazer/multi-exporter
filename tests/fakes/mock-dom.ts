import { NODE_TYPE_ELEMENT, NODE_TYPE_TEXT } from '../../src/core/dom';
import type { ElementLike, NodeLike, RootLike } from '../../src/core/dom';

/**
 * A hand-built DOM good enough for `src/core/`.
 *
 * `src/core/` works against a minimal structural interface rather than the real DOM, so the
 * tests need no jsdom, no `happy-dom` and no Obsidian runtime — which is exactly what makes
 * them deterministic. This implements only what core actually calls: `getAttribute`,
 * `classList.contains`, `textContent`, `childNodes` and a small `querySelectorAll` that
 * understands the handful of selector shapes core uses.
 */

export class MockText implements NodeLike {
	readonly nodeType = NODE_TYPE_TEXT;
	readonly nodeName = '#text';
	readonly childNodes: NodeLike[] = [];

	constructor(public textContent: string) {}
}

export interface MockElementInit {
	tag?: string;
	attrs?: Record<string, string>;
	classes?: string[];
	text?: string;
	children?: NodeLike[];
}

export class MockElement implements ElementLike {
	readonly nodeType = NODE_TYPE_ELEMENT;
	readonly nodeName: string;
	readonly attrs: Record<string, string>;
	readonly classes: Set<string>;
	readonly childNodes: NodeLike[];

	constructor(init: MockElementInit = {}) {
		this.nodeName = (init.tag ?? 'div').toUpperCase();
		this.attrs = { ...(init.attrs ?? {}) };
		this.classes = new Set(init.classes ?? []);
		this.childNodes = [...(init.children ?? [])];
		if (init.text !== undefined) this.childNodes.unshift(new MockText(init.text));
	}

	get classList(): { contains(token: string): boolean } {
		return { contains: (token: string) => this.classes.has(token) };
	}

	get textContent(): string {
		return this.childNodes.map((child) => child.textContent ?? '').join('');
	}

	getAttribute(name: string): string | null {
		return this.attrs[name] ?? null;
	}

	querySelectorAll(selector: string): ElementLike[] {
		const matchers = selector.split(',').map((part) => compileSelector(part.trim()));
		const found: ElementLike[] = [];
		const walk = (node: NodeLike): void => {
			for (let i = 0; i < node.childNodes.length; i++) {
				const child = node.childNodes[i];
				if (child === undefined || child.nodeType !== NODE_TYPE_ELEMENT) continue;
				const element = child as MockElement;
				if (matchers.some((matches) => matches(element))) found.push(element);
				walk(element);
			}
		};
		walk(this);
		return found;
	}
}

/**
 * Supports exactly the selector shapes core uses: `tag`, `.class`, and `tag.class`. Anything
 * else throws rather than quietly matching nothing, so a test cannot pass because its
 * selector was silently wrong.
 */
function compileSelector(selector: string): (element: MockElement) => boolean {
	const match = /^([a-zA-Z][a-zA-Z0-9]*)?((?:\.[A-Za-z0-9_-]+)*)$/.exec(selector);
	if (match === null) throw new Error(`mock-dom cannot parse selector: ${selector}`);

	const tag = match[1]?.toUpperCase();
	const classes = (match[2] ?? '')
		.split('.')
		.filter((token) => token.length > 0);

	return (element: MockElement): boolean => {
		if (tag !== undefined && element.nodeName !== tag) return false;
		return classes.every((token) => element.classes.has(token));
	};
}

/** Convenience for building a document root. */
export function root(...children: NodeLike[]): MockElement & RootLike {
	return new MockElement({ tag: 'div', children });
}

export function el(init: MockElementInit): MockElement {
	return new MockElement(init);
}

/** An `a.internal-link` as Obsidian renders one. */
export function internalLink(dataHref: string, text = dataHref): MockElement {
	return new MockElement({
		tag: 'a',
		classes: ['internal-link'],
		attrs: { 'data-href': dataHref, href: dataHref },
		text,
	});
}
