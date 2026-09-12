import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Regression test for the vendored paged.js table-header repeat.
 *
 * The bug: `rebuildAncestors` builds a split table's continuation page by shallow-cloning
 * only the cut node's own ancestor chain — `TD` → `TR` → `TBODY` → `TABLE` → … A `<thead>` is
 * never an ancestor of a `<td>` inside `<tbody>`, so it drops out of the clone silently: the
 * continuation page's table starts fresh with only body rows and no column labels, and
 * (see `src/core/page-css.ts`'s `table-layout: fixed`) whichever row lands first on that page
 * has no header row to anchor the CSS fixed-table-layout algorithm against either.
 *
 * As with the other two guards, the real function body is extracted from the shipped bundle
 * and executed — not a copy maintained here — so a re-vendor that loses the patch fails the
 * build rather than a review.
 */

const VENDOR_DIR = join(__dirname, '..', 'vendor', 'pagedjs');
const POLYFILL = readFileSync(join(VENDOR_DIR, 'paged.polyfill.js'), 'utf8');
const PATCH = readFileSync(join(VENDOR_DIR, 'repeat-table-thead.patch'), 'utf8');

/**
 * Just enough of a DOM node to drive `rebuildAncestors`'s ancestor-walking path: attributes,
 * parent/child links, and `cloneNode`. Real elements have far more surface than this; this
 * class implements exactly what the extracted function body calls.
 */
class FakeNode {
	nodeType = 1;
	parentNode: FakeNode | null = null;
	tHead: FakeNode | null = null;
	readonly children: FakeNode[] = [];
	private readonly attrs = new Map<string, string>();

	constructor(public readonly nodeName: string) {}

	cloneNode(deep: boolean): FakeNode {
		const clone = new FakeNode(this.nodeName);
		for (const [name, value] of this.attrs) clone.attrs.set(name, value);
		if (deep) {
			for (const child of this.children) {
				const childClone = child.cloneNode(true);
				childClone.parentNode = clone;
				clone.children.push(childClone);
			}
		}
		return clone;
	}

	getAttribute(name: string): string | null {
		return this.attrs.has(name) ? (this.attrs.get(name) as string) : null;
	}
	setAttribute(name: string, value: string): void {
		this.attrs.set(name, value);
	}
	hasAttribute(name: string): boolean {
		return this.attrs.has(name);
	}
	removeAttribute(name: string): void {
		this.attrs.delete(name);
	}
	appendChild(child: FakeNode): void {
		child.parentNode = this;
		this.children.push(child);
	}
	get parentElement(): FakeNode | null {
		return this.parentNode;
	}
	contains(node: FakeNode): boolean {
		return this.children.includes(node);
	}
}

/**
 * Pull `rebuildAncestors` out of the bundle and make it callable.
 *
 * It lives inside the bundle's IIFE closure and closes over the guest's own `document`, so a
 * minimal stand-in — just `createDocumentFragment` — is supplied as a parameter.
 */
function extractRebuildAncestors(): (node: FakeNode) => FakeNode {
	const match = /\n\tfunction rebuildAncestors\(node\) \{\n([\s\S]*?)\n\t\}\n/.exec(POLYFILL);
	if (match === null) {
		throw new Error('rebuildAncestors not found in the vendored paged.js — the vendored file has changed shape.');
	}
	const body = match[1] ?? '';
	const factory = new Function('document', `return function rebuildAncestors(node) {\n${body}\n};`) as (
		document: unknown,
	) => (node: FakeNode) => FakeNode;
	return factory({ createDocumentFragment: () => new FakeNode('#document-fragment') });
}

/** A table split mid-body: `<table><thead>…</thead><tbody><tr><td/></tr></tbody></table>`. */
function splitTableFixture(): { td: FakeNode; table: FakeNode; thead: FakeNode } {
	const th = new FakeNode('TH');
	th.setAttribute('data-label', 'Imp');
	const headerRow = new FakeNode('TR');
	headerRow.appendChild(th);
	const thead = new FakeNode('THEAD');
	thead.appendChild(headerRow);

	const table = new FakeNode('TABLE');
	table.tHead = thead;

	const tbody = new FakeNode('TBODY');
	table.appendChild(tbody);
	const tr = new FakeNode('TR');
	tbody.appendChild(tr);
	const td = new FakeNode('TD');
	tr.appendChild(td);

	return { td, table, thead };
}

describe('vendored paged.js table header repeat', () => {
	const rebuildAncestors = extractRebuildAncestors();

	function rebuiltTableOf(fragment: FakeNode): FakeNode | undefined {
		return fragment.children.find((child) => child.nodeName === 'TABLE');
	}

	it("carries the table's thead into the rebuilt continuation table", () => {
		const { td } = splitTableFixture();
		const table = rebuiltTableOf(rebuildAncestors(td));
		expect(table?.children.map((child) => child.nodeName)).toContain('THEAD');
	});

	it('clones the thead rather than moving the original', () => {
		const { td, thead } = splitTableFixture();
		const table = rebuiltTableOf(rebuildAncestors(td));
		const rebuiltThead = table?.children.find((child) => child.nodeName === 'THEAD');
		expect(rebuiltThead).not.toBe(thead);
		expect(thead.parentNode).toBeNull();
	});

	it('deep-clones it, so the header cells and their content survive', () => {
		const { td } = splitTableFixture();
		const table = rebuiltTableOf(rebuildAncestors(td));
		const rebuiltThead = table?.children.find((child) => child.nodeName === 'THEAD');
		expect(rebuiltThead?.children[0]?.children[0]?.getAttribute('data-label')).toBe('Imp');
	});

	it('puts the header before the body, preserving document order', () => {
		const { td } = splitTableFixture();
		const table = rebuiltTableOf(rebuildAncestors(td));
		expect(table?.children.map((child) => child.nodeName)).toEqual(['THEAD', 'TBODY']);
	});

	it('adds nothing when the table has no thead', () => {
		const { td, table } = splitTableFixture();
		table.tHead = null;
		const rebuilt = rebuiltTableOf(rebuildAncestors(td));
		expect(rebuilt?.children.map((child) => child.nodeName)).toEqual(['TBODY']);
	});
});

describe('the vendored table-thead patch', () => {
	it('is present in the vendored file, as the reviewer criterion requires', () => {
		expect(POLYFILL).toContain('if (parent.nodeName === "TABLE" && ancestor.tHead) {');
		expect(POLYFILL).toContain('parent.appendChild(ancestor.tHead.cloneNode(true));');
	});

	it('ships the diff alongside it, so a re-vendor can re-apply it', () => {
		expect(PATCH).toContain('--- a/vendor/pagedjs/paged.polyfill.js');
		expect(PATCH).toContain('+++ b/vendor/pagedjs/paged.polyfill.js');
		expect(PATCH).toContain('+\t\t\tif (parent.nodeName === "TABLE" && ancestor.tHead) {');
	});
});
