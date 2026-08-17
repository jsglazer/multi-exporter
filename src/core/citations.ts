import { toArray, walkTextNodes } from './dom';
import type { ElementLike, NodeLike, RootLike } from './dom';

/**
 * Citation detection over the **rendered DOM**, never over markdown source.
 *
 * That is forced by the architecture rather than preferred: `![[embeds]]` put a transcluded
 * note's citations in this DOM but not in this note's source, merged folder export has no
 * single source to scan, and Dataview/Datacore output only exists after rendering.
 *
 * Primary detection is an exact set intersection, not a regex: collect
 * `a.internal-link[data-href]`, strip any `#heading` / `#^block` suffix, and intersect
 * against the cite keys `zotero-manager` reports. This sidesteps the whole class of regex
 * false positives — email addresses, `@media` in code blocks, social handles in clipped
 * articles.
 */

/** Tags whose text is never scanned for Pandoc-style citations. */
export const CODE_TAGS: ReadonlySet<string> = new Set(['code', 'pre', 'kbd', 'samp']);

/** Pandoc-style citation clusters: `[@key]`, `[-@key]`, `[@a; @b]`. */
const PANDOC_CLUSTER = /\[(-?@[^\]]*)\]/g;
const PANDOC_KEY = /-?@([\w][\w:.#$%&+?<>~/-]*)/g;

export interface CitationLinkMatch {
	/** The `a.internal-link` element, so the shell can rewrite it in place. */
	element: ElementLike;
	/** The cite key, with any `#heading` / `#^block` suffix removed. */
	citeKey: string;
	/** Raw `data-href` as it appeared, for reporting. */
	rawHref: string;
}

export interface CitationScanOptions {
	/**
	 * Whether `[[wikilink]]`-shaped detection is meaningful for this vault. Derived from
	 * `zotero-manager`'s `citeSuggestTemplate` — see `isWikilinkShapedTemplate`.
	 */
	wikilinkDetection: boolean;
	/** Opt-in secondary text scan for Pandoc-style `[@key]`. Off by default. */
	pandocTextScan: boolean;
}

export interface CitationScanResult {
	/** Links whose target is a known cite key, in document order. */
	links: CitationLinkMatch[];
	/** Every distinct cite key found, in first-appearance order. */
	citeKeys: string[];
	/** Pandoc-style keys found by the opt-in text scan, in first-appearance order. */
	pandocKeys: string[];
}

/**
 * Strip a `#heading` or `#^block-id` suffix from a wikilink target.
 *
 * `[[smith2020#Methods]]` still cites `smith2020`. A leading `#` (a same-note heading link)
 * has no target and yields the empty string, which never intersects a cite key.
 */
export function stripSubpath(href: string): string {
	const hash = href.indexOf('#');
	return hash === -1 ? href.trim() : href.slice(0, hash).trim();
}

/**
 * Whether `zotero-manager`'s cite-suggest template actually inserts a wikilink.
 *
 * The template is user-configurable (default `[[{{citekey}}]]`), so the exporter must not
 * assume the wikilink form. We deliberately do **not** parse the template to extract keys —
 * `data-href` already carries the key. The template is read for one purpose only: to decide
 * whether wikilink detection can work at all.
 */
export function isWikilinkShapedTemplate(template: string | null | undefined): boolean {
	if (!template) return false;
	const open = template.indexOf('[[');
	if (open === -1) return false;
	const close = template.indexOf(']]', open + 2);
	if (close === -1) return false;
	const inner = template.slice(open + 2, close);
	return inner.includes('{{citekey}}');
}

/**
 * Scan a rendered document for citations.
 *
 * `citeKeys` is the set from `zotero-manager`'s `getAllCiteKeys()`. A link matches purely on
 * set membership: **note existence is never checked**. That is deliberate — checking would
 * require injecting a Vault into `src/core/`, and where a real note does exist at the cite
 * key's path the link is legitimately both a citation and a link. The profile's
 * `resolveCitations` flag, not the presence of a note, decides which it is treated as.
 */
export function scanCitations(
	root: RootLike,
	citeKeys: ReadonlySet<string>,
	options: CitationScanOptions,
): CitationScanResult {
	const links: CitationLinkMatch[] = [];
	const seen = new Set<string>();
	const ordered: string[] = [];

	if (options.wikilinkDetection) {
		for (const element of toArray(root.querySelectorAll('a.internal-link'))) {
			const rawHref = element.getAttribute('data-href');
			if (rawHref === null) continue;
			const citeKey = stripSubpath(rawHref);
			if (citeKey === '' || !citeKeys.has(citeKey)) continue;
			links.push({ element, citeKey, rawHref });
			if (!seen.has(citeKey)) {
				seen.add(citeKey);
				ordered.push(citeKey);
			}
		}
	}

	const pandocKeys = options.pandocTextScan ? scanPandocCitations(root, citeKeys) : [];
	for (const key of pandocKeys) {
		if (!seen.has(key)) {
			seen.add(key);
			ordered.push(key);
		}
	}

	return { links, citeKeys: ordered, pandocKeys };
}

/**
 * Secondary, opt-in scan for Pandoc-style `[@key]` clusters in text nodes.
 *
 * Bare `@key` is never matched — that is precisely the pattern that turns email addresses
 * and `@media` rules into citations. `code`, `pre`, `kbd` and `samp` subtrees are skipped
 * entirely, and results are still intersected against the known cite keys.
 */
export function scanPandocCitations(root: NodeLike | RootLike, citeKeys: ReadonlySet<string>): string[] {
	if (!isNodeLike(root)) return [];
	const found: string[] = [];
	const seen = new Set<string>();

	walkTextNodes(root, CODE_TAGS, (node) => {
		const text = node.textContent ?? '';
		if (text.indexOf('[') === -1) return;
		for (const cluster of text.matchAll(PANDOC_CLUSTER)) {
			const body = cluster[1] ?? '';
			for (const keyMatch of body.matchAll(PANDOC_KEY)) {
				const key = keyMatch[1];
				if (key === undefined || seen.has(key) || !citeKeys.has(key)) continue;
				seen.add(key);
				found.push(key);
			}
		}
	});

	return found;
}

function isNodeLike(value: NodeLike | RootLike): value is NodeLike {
	return 'childNodes' in value;
}

/** Cite keys reported by `zotero-manager`, reduced to the set the intersection needs. */
export function toCiteKeySet(entries: readonly { citekey: string }[]): Set<string> {
	return new Set(entries.map((entry) => entry.citekey));
}
