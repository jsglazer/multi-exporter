import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Regression test for the vendored paged.js double-removal guard.
 *
 * The bug, reproduced in headless Chromium against the real Manuscript stylesheet: paged.js
 * registers a rule handler for `*-of-type` pseudos (`NthOfType`) and another for sibling
 * combinators (`Following`), and **each removes the rule it rewrites**. A selector list
 * holding both kinds — `p:first-of-type, h1 + p { text-indent: 0 }`, ordinary CSS and exactly
 * what the Manuscript profile shipped — matches both handlers, so the second one removes an
 * item csstree has already unlinked and `List.remove` throws `item doesn't belong to list`
 * from inside the polisher. Pagination dies before a single page is laid out.
 *
 * The failure was doubly disguised: `executeJavaScript` re-raises any in-guest exception as
 * `Error invoking remote method 'GUEST_VIEW_MANAGER_CALL': Error: <message>`, so a stylesheet
 * bug arrived at the user reading like a crashed renderer process.
 *
 * As with `pagedjs-null-guard.test.ts`, the real function bodies are extracted from the
 * shipped bundle and executed — not copies maintained here — so a re-vendor that loses the
 * patch fails the build rather than a review.
 */

const VENDOR_DIR = join(__dirname, '..', 'vendor', 'pagedjs');
const POLYFILL = readFileSync(join(VENDOR_DIR, 'paged.polyfill.js'), 'utf8');
const PATCH = readFileSync(join(VENDOR_DIR, 'nth-of-type-following-double-remove.patch'), 'utf8');

/** csstree's `List.remove`, reduced to the invariant that throws. */
interface ListItem {
	prev: ListItem | null;
	next: ListItem | null;
}

class MiniList {
	head: ListItem | null;
	tail: ListItem | null;

	constructor(item: ListItem) {
		this.head = item;
		this.tail = item;
	}

	remove(item: ListItem): void {
		if (item.prev !== null) {
			item.prev.next = item.next;
		} else {
			if (this.head !== item) throw new Error("item doesn't belong to list");
			this.head = item.next;
		}
		if (item.next !== null) {
			item.next.prev = item.prev;
		} else {
			if (this.tail !== item) throw new Error("item doesn't belong to list");
			this.tail = item.prev;
		}
		item.prev = null;
		item.next = null;
	}
}

type OnRule = (ruleNode: unknown, ruleItem: ListItem, rulelist: MiniList) => void;

/**
 * Pull one handler's `onRule` out of the bundle and make it callable.
 *
 * It lives inside the bundle's IIFE closure and closes over `csstree`, `UUID` and the patched
 * `mxRemoveRuleOnce`, so all three are supplied as parameters to the reconstructed function.
 * `csstree.generate` is stubbed to return the selector or block it is handed, which is all
 * either handler reads.
 */
function extractOnRule(className: string): OnRule {
	const pattern = new RegExp(
		`class ${className} extends Handler \\{[\\s\\S]*?\\n\\t\\tonRule\\(ruleNode, ruleItem, rulelist\\) \\{\\n([\\s\\S]*?)\\n\\t\\t\\}\\n`,
	);
	const match = pattern.exec(POLYFILL);
	if (match === null) {
		throw new Error(`${className}.onRule not found in the vendored paged.js — the vendored file has changed shape.`);
	}

	const guard = /\n\tfunction mxRemoveRuleOnce\(rulelist, ruleItem\) \{\n([\s\S]*?)\n\t\}\n/.exec(POLYFILL);
	if (guard === null) {
		throw new Error('The mxRemoveRuleOnce guard is missing from the vendored paged.js — re-apply the patch.');
	}

	const factory = new Function(
		'csstree',
		'UUID',
		`function mxRemoveRuleOnce(rulelist, ruleItem) {\n${guard[1] ?? ''}\n}\n` +
			`return function onRule(ruleNode, ruleItem, rulelist) {\n${match[1] ?? ''}\n};`,
	) as (csstree: unknown, uuid: unknown) => OnRule;

	let counter = 0;
	return factory({ generate: (node: unknown) => String(node) }, () => `uuid-${++counter}`);
}

/** The rule both handlers claim: a `*-of-type` pseudo and a `+` combinator in one list. */
function crashingRule(): { node: { prelude: string; block: string }; item: ListItem; list: MiniList } {
	const item: ListItem = { prev: null, next: null };
	return {
		node: { prelude: 'p:first-of-type, h1 + p, h2 + p', block: '{text-indent:0}' },
		item,
		list: new MiniList(item),
	};
}

describe('vendored paged.js NthOfType/Following double removal', () => {
	// `this.selectors` is the only instance state either body touches.
	const bind = (onRule: OnRule): OnRule => onRule.bind({ selectors: {} } as never);

	it('does not throw when both handlers claim the same rule', () => {
		const nthOfType = bind(extractOnRule('NthOfType'));
		const following = bind(extractOnRule('Following'));
		const { node, item, list } = crashingRule();

		nthOfType(node, item, list);
		// Before the patch this threw "item doesn't belong to list" out of the polisher.
		expect(() => following(node, item, list)).not.toThrow();
	});

	it('still removes the rule exactly once, in whichever order the handlers run', () => {
		for (const order of [
			['NthOfType', 'Following'],
			['Following', 'NthOfType'],
		]) {
			const { node, item, list } = crashingRule();
			for (const name of order) bind(extractOnRule(name))(node, item, list);
			expect(list.head).toBeNull();
			expect(list.tail).toBeNull();
		}
	});

	it('both handlers still record the selector, so neither rewrite is lost', () => {
		for (const name of ['NthOfType', 'Following']) {
			const selectors: Record<string, [string, string]> = {};
			const onRule = extractOnRule(name).bind({ selectors } as never);
			const { node, item, list } = crashingRule();
			onRule(node, item, list);
			expect(Object.keys(selectors)).toContain('p:first-of-type');
		}
	});

	it('leaves a rule only one handler claims removed as before', () => {
		const item: ListItem = { prev: null, next: null };
		const list = new MiniList(item);
		bind(extractOnRule('NthOfType'))({ prelude: 'p:first-of-type', block: '{text-indent:0}' }, item, list);
		expect(list.head).toBeNull();
	});

	it('leaves a rule neither handler claims in the list', () => {
		const item: ListItem = { prev: null, next: null };
		const list = new MiniList(item);
		const node = { prelude: 'p', block: '{text-indent:0}' };
		bind(extractOnRule('NthOfType'))(node, item, list);
		bind(extractOnRule('Following'))(node, item, list);
		expect(list.head).toBe(item);
	});
});

describe('the vendored double-removal patch', () => {
	it('routes both removals through the guard rather than csstree directly', () => {
		expect(POLYFILL).toContain('mxRemoveRuleOnce(rulelist, ruleItem);');
		expect(POLYFILL.split('mxRemoveRuleOnce(rulelist, ruleItem);').length - 1).toBe(2);
		expect(POLYFILL).not.toContain('\t\t\t\trulelist.remove(ruleItem);');
	});

	it('ships the diff alongside it, so a re-vendor can re-apply it', () => {
		expect(PATCH).toContain('--- a/vendor/pagedjs/paged.polyfill.js');
		expect(PATCH).toContain('+++ b/vendor/pagedjs/paged.polyfill.js');
		expect(PATCH).toContain('+\tfunction mxRemoveRuleOnce(rulelist, ruleItem) {');
	});
});
