import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Regression test for the vendored paged.js `findElement` null guard.
 *
 * The bug: at a page boundary the layout builder calls `findElement(node.parentNode, dest)`
 * where `parentNode` is null, and `node.getAttribute("data-ref")` throws a `TypeError` from
 * inside paged.js — pagination aborts with no useful error and the export silently produces
 * nothing.
 *
 * The audit made the fix a **read-check** ("confirm the patch is present"). That is the
 * weakest possible guard: any re-vendor reverts it silently, and the symptom is a crash at a
 * page boundary rather than a failing test. So the patch is guarded here instead.
 *
 * What this test can and cannot do: paged.js paginates by measuring real layout, and no
 * headless DOM implements layout, so *running a full pagination* is not something a
 * deterministic test can do — that part is in the ~20% the audit assigned to manual QA.
 * What it does instead is extract the real `findElement` from the vendored file and execute
 * it against the exact null input that crashed, which reproduces the failure precisely and
 * fails if the guard is ever lost.
 */

const VENDOR_DIR = join(__dirname, '..', 'vendor', 'pagedjs');
const POLYFILL = readFileSync(join(VENDOR_DIR, 'paged.polyfill.js'), 'utf8');
const PATCH = readFileSync(join(VENDOR_DIR, 'findElement-null-guard.patch'), 'utf8');

/**
 * Pull `findElement` out of the bundle and make it callable.
 *
 * It lives inside the bundle's IIFE closure, so it cannot be reached by importing the file.
 * Extracting the source and evaluating it with a stubbed `findRef` exercises the real,
 * shipped function body — not a copy of it maintained in this test.
 */
function extractFindElement(): (node: unknown, doc: unknown, forceQuery?: boolean) => unknown {
	const match = /\n\tfunction findElement\(node, doc, forceQuery\) \{\n([\s\S]*?)\n\t\}\n/.exec(POLYFILL);
	if (match === null) {
		throw new Error('findElement not found in the vendored paged.js — the vendored file has changed shape.');
	}
	const body = match[1] ?? '';
	const factory = new Function(
		'findRef',
		`return function findElement(node, doc, forceQuery) {\n${body}\n};`,
	) as (findRef: unknown) => (node: unknown, doc: unknown, forceQuery?: boolean) => unknown;

	// Stands in for the real `findRef`, which only does a `querySelector` by data-ref.
	const findRef = (ref: string, doc: { refs: Record<string, unknown> }): unknown => doc.refs[ref] ?? null;
	return factory(findRef);
}

describe('vendored paged.js findElement', () => {
	const findElement = extractFindElement();
	const doc = { refs: { 'ref-1': { id: 'the-node' } } };

	// The crash, reproduced: `findElement(node.parentNode, dest)` at a layout boundary where
	// `parentNode` is null. Without the guard this throws
	// "Cannot read properties of null (reading 'getAttribute')".
	it('returns null instead of throwing when the node is null', () => {
		expect(() => findElement(null, doc)).not.toThrow();
		expect(findElement(null, doc)).toBeNull();
	});

	it('returns null for an undefined node too', () => {
		expect(findElement(undefined, doc)).toBeNull();
	});

	it('still resolves a real node through findRef', () => {
		const node = { getAttribute: (name: string) => (name === 'data-ref' ? 'ref-1' : null) };
		expect(findElement(node, doc)).toEqual({ id: 'the-node' });
	});

	it('returns null for a node whose data-ref matches nothing', () => {
		const node = { getAttribute: () => 'missing' };
		expect(findElement(node, doc)).toBeNull();
	});
});

describe('the vendored patch', () => {
	it('is present in the vendored file, as the reviewer criterion requires', () => {
		expect(POLYFILL).toContain('if (!node) return null;');
	});

	it('guards the very start of findElement, before any property access', () => {
		const index = POLYFILL.indexOf('function findElement(node, doc, forceQuery) {');
		const guard = POLYFILL.indexOf('if (!node) return null;', index);
		const firstAccess = POLYFILL.indexOf('node.getAttribute("data-ref")', index);
		expect(guard).toBeGreaterThan(index);
		expect(guard).toBeLessThan(firstAccess);
	});

	it('ships the diff alongside it, so a re-vendor can re-apply it', () => {
		expect(PATCH).toContain('--- a/vendor/pagedjs/paged.polyfill.js');
		expect(PATCH).toContain('+++ b/vendor/pagedjs/paged.polyfill.js');
		expect(PATCH).toContain('+\t\tif (!node) return null;');
	});
});
