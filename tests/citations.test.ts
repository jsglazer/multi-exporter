import { describe, expect, it } from 'vitest';
import {
	isWikilinkShapedTemplate,
	scanCitations,
	scanPandocCitations,
	stripSubpath,
	toCiteKeySet,
} from '../src/core/citations';
import { el, internalLink, root } from './fakes/mock-dom';

/**
 * Deterministic test requirement: "Unit-test DOM link-scanning and cite-key set intersection
 * using mock HTML trees."
 */

const KEYS = new Set(['smith2020', 'jones2019', 'ostrom1990']);
const WIKILINK = { wikilinkDetection: true, pandocTextScan: false };

describe('stripSubpath', () => {
	it('drops a heading suffix', () => {
		expect(stripSubpath('smith2020#Methods')).toBe('smith2020');
	});

	it('drops a block reference', () => {
		expect(stripSubpath('smith2020#^abc123')).toBe('smith2020');
	});

	it('leaves a plain target alone', () => {
		expect(stripSubpath('smith2020')).toBe('smith2020');
	});

	it('yields an empty target for a same-note heading link', () => {
		expect(stripSubpath('#Methods')).toBe('');
	});
});

describe('isWikilinkShapedTemplate', () => {
	it('accepts the zotero-manager default', () => {
		expect(isWikilinkShapedTemplate('[[{{citekey}}]]')).toBe(true);
	});

	it('accepts a wikilink with an alias', () => {
		expect(isWikilinkShapedTemplate('[[{{citekey}}|cite]]')).toBe(true);
	});

	// The decision this encodes: a non-wikilink template disables wikilink detection rather
	// than being parsed for keys. `data-href` already carries the key.
	it('rejects a Pandoc-shaped template', () => {
		expect(isWikilinkShapedTemplate('[@{{citekey}}]')).toBe(false);
	});

	it('rejects a template whose placeholder sits outside the brackets', () => {
		expect(isWikilinkShapedTemplate('{{citekey}} [[note]]')).toBe(false);
	});

	it('rejects empty and missing templates', () => {
		expect(isWikilinkShapedTemplate('')).toBe(false);
		expect(isWikilinkShapedTemplate(null)).toBe(false);
		expect(isWikilinkShapedTemplate(undefined)).toBe(false);
	});
});

describe('scanCitations', () => {
	it('matches links whose data-href is a known cite key', () => {
		const document = root(
			el({ tag: 'p', children: [internalLink('smith2020')] }),
			el({ tag: 'p', children: [internalLink('Meeting notes')] }),
		);
		const result = scanCitations(document, KEYS, WIKILINK);
		expect(result.citeKeys).toEqual(['smith2020']);
		expect(result.links).toHaveLength(1);
		expect(result.links[0]?.rawHref).toBe('smith2020');
	});

	it('matches through a heading suffix but reports the bare key', () => {
		const document = root(internalLink('jones2019#Findings'));
		const result = scanCitations(document, KEYS, WIKILINK);
		expect(result.links[0]).toMatchObject({ citeKey: 'jones2019', rawHref: 'jones2019#Findings' });
	});

	it('reports each key once, in first-appearance order', () => {
		const document = root(
			internalLink('ostrom1990'),
			internalLink('smith2020'),
			internalLink('ostrom1990#Ch2'),
		);
		expect(scanCitations(document, KEYS, WIKILINK).citeKeys).toEqual(['ostrom1990', 'smith2020']);
		expect(scanCitations(document, KEYS, WIKILINK).links).toHaveLength(3);
	});

	// Set intersection, not a regex. These are the exact false positives a regex produces on
	// a clipped article, and none of them may match.
	it('never matches things that merely look like cite keys', () => {
		const document = root(
			el({ tag: 'p', text: 'Write to editor@example.com or ask @someone.' }),
			el({ tag: 'pre', children: [el({ tag: 'code', text: '@media print { @page { margin: 0 } }' })] }),
			internalLink('smith2020 draft'),
		);
		expect(scanCitations(document, KEYS, WIKILINK).citeKeys).toEqual([]);
	});

	it('ignores links with no data-href', () => {
		const document = root(el({ tag: 'a', classes: ['internal-link'], text: 'smith2020' }));
		expect(scanCitations(document, KEYS, WIKILINK).links).toEqual([]);
	});

	it('ignores external links entirely', () => {
		const document = root(
			el({ tag: 'a', classes: ['external-link'], attrs: { 'data-href': 'smith2020' }, text: 'smith2020' }),
		);
		expect(scanCitations(document, KEYS, WIKILINK).citeKeys).toEqual([]);
	});

	it('finds nothing when wikilink detection is disabled', () => {
		const document = root(internalLink('smith2020'));
		const result = scanCitations(document, KEYS, { wikilinkDetection: false, pandocTextScan: false });
		expect(result.links).toEqual([]);
		expect(result.citeKeys).toEqual([]);
	});

	// Decision: note existence is never checked. Core has no Vault, and a cite key that also
	// names a real note is still a citation when the flag is on.
	it('matches a cite key regardless of whether a note exists at that path', () => {
		const document = root(internalLink('smith2020'));
		expect(scanCitations(document, KEYS, WIKILINK).links).toHaveLength(1);
	});
});

describe('scanPandocCitations', () => {
	it('finds bracketed keys when the opt-in scan is on', () => {
		const document = root(el({ tag: 'p', text: 'As argued [@smith2020] and elsewhere [-@jones2019].' }));
		expect(scanPandocCitations(document, KEYS)).toEqual(['smith2020', 'jones2019']);
	});

	it('splits a multi-key cluster', () => {
		const document = root(el({ tag: 'p', text: 'See [@smith2020; @ostrom1990].' }));
		expect(scanPandocCitations(document, KEYS)).toEqual(['smith2020', 'ostrom1990']);
	});

	it('never matches a bare @key', () => {
		const document = root(el({ tag: 'p', text: 'Per @smith2020 the answer is no.' }));
		expect(scanPandocCitations(document, KEYS)).toEqual([]);
	});

	it('skips code, pre, kbd and samp subtrees', () => {
		const document = root(
			el({ tag: 'code', text: '[@smith2020]' }),
			el({ tag: 'pre', text: '[@jones2019]' }),
			el({ tag: 'kbd', text: '[@ostrom1990]' }),
			el({ tag: 'samp', text: '[@smith2020]' }),
		);
		expect(scanPandocCitations(document, KEYS)).toEqual([]);
	});

	it('still intersects against the known keys', () => {
		const document = root(el({ tag: 'p', text: '[@notinlibrary]' }));
		expect(scanPandocCitations(document, KEYS)).toEqual([]);
	});

	it('merges into the combined result when enabled', () => {
		const document = root(internalLink('smith2020'), el({ tag: 'p', text: '[@jones2019]' }));
		const result = scanCitations(document, KEYS, { wikilinkDetection: true, pandocTextScan: true });
		expect(result.citeKeys).toEqual(['smith2020', 'jones2019']);
		expect(result.pandocKeys).toEqual(['jones2019']);
	});
});

describe('toCiteKeySet', () => {
	it('reduces zotero-manager entries to the set the intersection needs', () => {
		const set = toCiteKeySet([
			{ citekey: 'smith2020' },
			{ citekey: 'jones2019' },
			{ citekey: 'smith2020' },
		]);
		expect([...set].sort()).toEqual(['jones2019', 'smith2020']);
	});
});
