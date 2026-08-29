import { isElement, isText, NODE_TYPE_ELEMENT, tagName, toArray } from './dom';
import type { NodeLike } from './dom';

/**
 * Locating `md-annotation` records inside a rendered note.
 *
 * The plugin's public API returns annotation *records* — a W3C `TextQuoteSelector` each —
 * and no positions. Its own matcher (`src/core/matcher.ts`, `CONTEXT_LENGTH = 32`,
 * `HIGH_CONFIDENCE = 0.75`) is internal and not exposed, so the positions have to be
 * recovered here.
 *
 * The two texts are not the same text, which is the whole difficulty: a selector's `exact`,
 * `prefix` and `suffix` were captured from the **markdown source**, and what has to be
 * annotated is the **rendered DOM**. `*universal*` in the source is `universal` on the page,
 * `[^3]` becomes a footnote link, a table's stored context is the raw pipe-delimited row.
 * So matching is staged, each stage only running when the one before it found nothing:
 *
 * 1. exact substring of the quote, disambiguated by context when it occurs more than once;
 * 2. the same over whitespace-normalised text, which is what survives re-wrapping;
 * 3. an anchor search — find the tail of the stored prefix, score what follows it;
 * 4. a coarse fuzzy sweep, for a quote whose own characters changed.
 *
 * Ambiguity is never resolved by guessing: two candidates too close to call are reported as
 * unmatched, exactly as `md-annotation` orphans them.
 */

export interface TextQuoteSelector {
	exact: string;
	prefix: string;
	suffix: string;
}

/** One text node's span within the flattened string. */
export interface TextRun {
	node: NodeLike;
	/** Offset of this node's first character in the flat text. */
	start: number;
	/** Offset one past this node's last character. */
	end: number;
}

export interface FlatText {
	text: string;
	runs: TextRun[];
}

/** A resolved position in the flat text. `start === end` is a caret, not a range. */
export interface Located {
	start: number;
	end: number;
	/** 1 for an exact quote in unambiguous context; never below `MIN_CONFIDENCE`. */
	confidence: number;
}

/** Below this a match is reported unmatched rather than drawn in the wrong place. */
export const MIN_CONFIDENCE = 0.75;

/** Two candidates closer than this are "too close to call" — unmatched, never a guess. */
export const AMBIGUITY_MARGIN = 0.05;

/** `md-annotation` captures this many characters of context on each side. */
export const CONTEXT_LENGTH = 32;

/** Innermost slice of the stored context, nearest the quote, used as the stage-3 anchor. */
const ANCHOR_LENGTH = 16;

/** Elements whose text is not note prose and must never be annotated. */
const SKIP_TAGS = new Set(['script', 'style', 'code', 'pre', 'textarea', 'svg', 'math']);

/**
 * Flatten a rendered subtree to text, keeping the map back to its text nodes.
 *
 * `skipClasses` takes out whole subtrees the export itself appended — a bibliography, a
 * previous endnotes section — which are not part of the note and must not attract a match.
 */
export function flattenText(root: NodeLike, skipClasses: readonly string[] = []): FlatText {
	const runs: TextRun[] = [];
	let text = '';

	const visit = (node: NodeLike): void => {
		if (isText(node)) {
			const value = node.textContent ?? '';
			if (value === '') return;
			runs.push({ node, start: text.length, end: text.length + value.length });
			text += value;
			return;
		}
		if (node.nodeType !== NODE_TYPE_ELEMENT) return;
		if (SKIP_TAGS.has(tagName(node))) return;
		if (isElement(node) && skipClasses.some((cls) => node.classList.contains(cls))) return;
		for (const child of toArray(node.childNodes)) visit(child);
	};

	for (const child of toArray(root.childNodes)) visit(child);
	return { text, runs };
}

/** The runs a `[start, end)` flat-text range touches, clipped to node-local offsets. */
export function runsForRange(
	flat: FlatText,
	start: number,
	end: number,
): { node: NodeLike; from: number; to: number }[] {
	const out: { node: NodeLike; from: number; to: number }[] = [];
	for (const run of flat.runs) {
		if (run.end <= start || run.start >= end) continue;
		const from = Math.max(start, run.start) - run.start;
		const to = Math.min(end, run.end) - run.start;
		if (to > from) out.push({ node: run.node, from, to });
	}
	return out;
}

/** The run containing a caret offset, and the offset within it. */
export function runForCaret(flat: FlatText, at: number): { node: NodeLike; offset: number } | null {
	for (const run of flat.runs) {
		if (at >= run.start && at <= run.end) return { node: run.node, offset: at - run.start };
	}
	return null;
}

/**
 * Resolve one selector against the flat text, or `null` when it cannot be placed.
 *
 * A zero-length `exact` is a point comment: it anchors on its context alone and resolves to
 * a caret, which is what the endnote marker or gutter tick attaches to.
 */
export function locate(flat: string, selector: TextQuoteSelector): Located | null {
	if (selector.exact === '') return locateCaret(flat, selector);

	const exact = byExact(flat, selector);
	if (exact !== null) return exact;

	const normalised = byNormalised(flat, selector);
	if (normalised !== null) return normalised;

	const anchored = byAnchor(flat, selector);
	if (anchored !== null) return anchored;

	return byFuzzySweep(flat, selector);
}

/* ------------------------------------------------------------------ stage 1: exact -- */

function byExact(flat: string, selector: TextQuoteSelector): Located | null {
	const hits = occurrences(flat, selector.exact);
	if (hits.length === 0) return null;
	if (hits.length === 1) {
		const start = hits[0] as number;
		return { start, end: start + selector.exact.length, confidence: 1 };
	}
	return disambiguate(flat, selector, hits, selector.exact.length);
}

/**
 * Pick between several occurrences of the same quote using the stored context.
 *
 * Returns `null` when the best two are within `AMBIGUITY_MARGIN`: the annotation is then
 * reported unmatched, because putting it on the wrong one of two identical sentences is a
 * worse outcome than saying it could not be placed.
 */
function disambiguate(
	flat: string,
	selector: TextQuoteSelector,
	starts: readonly number[],
	length: number,
): Located | null {
	const scored = starts
		.map((start) => ({ start, score: contextScore(flat, start, start + length, selector) }))
		.sort((a, b) => b.score - a.score);
	const best = scored[0];
	const runnerUp = scored[1];
	if (best === undefined) return null;
	if (runnerUp !== undefined && best.score - runnerUp.score < AMBIGUITY_MARGIN) return null;
	return { start: best.start, end: best.start + length, confidence: Math.max(MIN_CONFIDENCE, best.score) };
}

/**
 * How well the text around a candidate agrees with the selector's stored context.
 *
 * Averaged over whichever sides the selector actually has: a quote at the very start of a
 * note has an empty prefix, and scoring that as a mismatch would penalise the one candidate
 * that is right.
 */
function contextScore(flat: string, start: number, end: number, selector: TextQuoteSelector): number {
	const scores: number[] = [];

	// Both sides are keyed, then the candidate's window is trimmed to the *keyed* length.
	// Keying can shorten a window a great deal — a table row is mostly delimiters — and
	// scoring a six-character key against a thirty-two-character window penalises the
	// candidate for text the selector never claimed to describe.
	const prefixKey = contextKey(selector.prefix);
	if (prefixKey !== '') {
		const window = contextKey(flat.slice(Math.max(0, start - selector.prefix.length), start));
		scores.push(similarity(prefixKey, window.slice(-prefixKey.length)));
	}
	const suffixKey = contextKey(selector.suffix);
	if (suffixKey !== '') {
		const window = contextKey(flat.slice(end, end + selector.suffix.length));
		scores.push(similarity(suffixKey, window.slice(0, suffixKey.length)));
	}
	if (scores.length === 0) return 0.5;
	return scores.reduce((sum, value) => sum + value, 0) / scores.length;
}

/**
 * A context window reduced to the part that survives rendering.
 *
 * Table cells are the reason this exists. A selector inside a table stores the **raw
 * markdown row** as its context — `| Three | bob | Highlight ` — and none of those pipes or
 * padding spaces appear in the rendered table, where the same words are the text content of
 * three separate cells. Scored literally, every candidate for a short quote like "here"
 * looks equally wrong, the two best tie, and a perfectly locatable annotation is orphaned.
 * Dropping the row delimiters and collapsing the padding leaves the words, which are the
 * part both texts actually agree on.
 */
function contextKey(text: string): string {
	return text.replace(/\|/g, ' ').replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------- stage 2: whitespace-normal -- */

/**
 * The same search over collapsed whitespace.
 *
 * Rendering re-wraps text: a quote that spanned a line break in the source arrives with a
 * single space, and a quote captured across an indented list item arrives with none of the
 * indentation. Collapsing both sides makes those the same string again, and the offset map
 * carries the answer back to real positions.
 */
function byNormalised(flat: string, selector: TextQuoteSelector): Located | null {
	const collapsed = collapse(flat);
	const needle = collapse(selector.exact).text;
	if (needle === '') return null;
	const hits = occurrences(collapsed.text, needle);
	if (hits.length === 0) return null;

	const map = (index: number): number => collapsed.offsets[index] ?? flat.length;
	if (hits.length === 1) {
		const start = hits[0] as number;
		return { start: map(start), end: map(start + needle.length - 1) + 1, confidence: 0.95 };
	}
	const picked = disambiguate(collapsed.text, { ...selector, exact: needle }, hits, needle.length);
	if (picked === null) return null;
	return { start: map(picked.start), end: map(picked.end - 1) + 1, confidence: Math.min(picked.confidence, 0.95) };
}

/** Collapsed text plus, for each collapsed character, its offset in the original. */
function collapse(text: string): { text: string; offsets: number[] } {
	let out = '';
	const offsets: number[] = [];
	let pendingSpace = false;
	for (let i = 0; i < text.length; i++) {
		const char = text[i] as string;
		if (/\s/.test(char)) {
			pendingSpace = out !== '';
			continue;
		}
		if (pendingSpace) {
			out += ' ';
			offsets.push(i);
			pendingSpace = false;
		}
		out += char;
		offsets.push(i);
	}
	return { text: out, offsets };
}

/* ----------------------------------------------------------------- stage 3: anchor -- */

/**
 * Find the tail of the stored prefix and score whatever follows it against the quote.
 *
 * This is the stage that survives an edited quote: the surrounding text is untouched far
 * more often than the highlighted words are, so the context is the more reliable landmark.
 */
function byAnchor(flat: string, selector: TextQuoteSelector): Located | null {
	const anchor = selector.prefix.slice(-ANCHOR_LENGTH);
	if (anchor.trim() === '') return null;
	const hits = occurrences(flat, anchor);
	if (hits.length === 0 || hits.length > 8) return null;

	let best: Located | null = null;
	for (const hit of hits) {
		const start = hit + anchor.length;
		const end = Math.min(flat.length, start + selector.exact.length);
		const score = similarity(selector.exact, flat.slice(start, end));
		if (score < MIN_CONFIDENCE) continue;
		if (best === null || score > best.confidence) best = { start, end, confidence: score };
	}
	return best;
}

/* ------------------------------------------------------------------ stage 4: fuzzy -- */

/**
 * A coarse sweep for a quote whose own characters have changed.
 *
 * Deliberately last and deliberately cheap: it steps a quote-length window a quarter of a
 * quote at a time and only refines around the best coarse hit, because a fine sweep of a
 * hundred-kilobyte note for every one of sixty annotations is not affordable and buys
 * nothing — anything this stage can find is already approximate.
 */
function byFuzzySweep(flat: string, selector: TextQuoteSelector): Located | null {
	const length = selector.exact.length;
	if (length < 8 || flat.length < length) return null;

	const coarse = Math.max(1, Math.floor(length / 4));
	let bestStart = -1;
	let bestScore = 0;
	for (let start = 0; start + length <= flat.length; start += coarse) {
		const score = similarity(selector.exact, flat.slice(start, start + length));
		if (score > bestScore) {
			bestScore = score;
			bestStart = start;
		}
	}
	if (bestStart < 0 || bestScore < MIN_CONFIDENCE - 0.1) return null;

	for (let start = Math.max(0, bestStart - coarse); start <= Math.min(flat.length - length, bestStart + coarse); start++) {
		const score = similarity(selector.exact, flat.slice(start, start + length));
		if (score > bestScore) {
			bestScore = score;
			bestStart = start;
		}
	}
	if (bestScore < MIN_CONFIDENCE) return null;
	return { start: bestStart, end: bestStart + length, confidence: bestScore };
}

/* ------------------------------------------------------------------ point comments -- */

/**
 * Resolve a comment that highlights nothing.
 *
 * Such a record has an empty `exact` and carries only its two context windows, so the caret
 * is wherever those two meet. The prefix is tried first — a comment is attached *after*
 * something — and the suffix is the fallback for a comment at the very start of a note.
 */
function locateCaret(flat: string, selector: TextQuoteSelector): Located | null {
	const prefixAnchor = selector.prefix.slice(-ANCHOR_LENGTH);
	if (prefixAnchor.trim() !== '') {
		const hits = occurrences(flat, prefixAnchor);
		if (hits.length === 1) {
			const at = (hits[0] as number) + prefixAnchor.length;
			return { start: at, end: at, confidence: 1 };
		}
		if (hits.length > 1) {
			const scored = hits
				.map((hit) => ({ at: hit + prefixAnchor.length, score: similarity(selector.suffix, flat.slice(hit + prefixAnchor.length, hit + prefixAnchor.length + selector.suffix.length)) }))
				.sort((a, b) => b.score - a.score);
			const best = scored[0];
			const runnerUp = scored[1];
			if (best !== undefined && (runnerUp === undefined || best.score - runnerUp.score >= AMBIGUITY_MARGIN)) {
				return { start: best.at, end: best.at, confidence: Math.max(MIN_CONFIDENCE, best.score) };
			}
		}
	}

	const suffixAnchor = selector.suffix.slice(0, ANCHOR_LENGTH);
	if (suffixAnchor.trim() === '') return null;
	const hits = occurrences(flat, suffixAnchor);
	if (hits.length !== 1) return null;
	const at = hits[0] as number;
	return { start: at, end: at, confidence: 0.9 };
}

/* ----------------------------------------------------------------------- utilities -- */

/**
 * How many occurrences of one quote are worth collecting.
 *
 * Generous, because the cap is not a shortcut — it is what stops a pathological input from
 * building an unbounded list. Truncating early is worse than useless: a one-word highlight
 * like "here" occurs hundreds of times in a book-length note, and cutting the list off at
 * the first few dozen throws away the occurrence the context would have picked, turning a
 * resolvable annotation into an orphan. Scoring a few thousand candidates against a
 * 32-character window costs nothing.
 */
const OCCURRENCE_LIMIT = 4096;

/** Every start index of `needle` in `haystack`. Overlaps are not wanted, so it steps past. */
function occurrences(haystack: string, needle: string): number[] {
	if (needle === '') return [];
	const out: number[] = [];
	let from = 0;
	for (;;) {
		const index = haystack.indexOf(needle, from);
		if (index < 0) return out;
		out.push(index);
		from = index + needle.length;
		if (out.length >= OCCURRENCE_LIMIT) return out;
	}
}

/**
 * Dice coefficient over character bigrams: 1 for identical strings, 0 for nothing in common.
 *
 * Chosen over edit distance because it is linear rather than quadratic and is insensitive
 * to where a difference falls, which is the right shape here — markdown syntax stripped out
 * of the middle of a quote should cost about as much as the same characters stripped off
 * its end.
 */
export function similarity(a: string, b: string): number {
	if (a === b) return 1;
	if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
	const counts = new Map<string, number>();
	for (let i = 0; i < a.length - 1; i++) {
		const gram = a.slice(i, i + 2);
		counts.set(gram, (counts.get(gram) ?? 0) + 1);
	}
	let shared = 0;
	for (let i = 0; i < b.length - 1; i++) {
		const gram = b.slice(i, i + 2);
		const available = counts.get(gram) ?? 0;
		if (available > 0) {
			counts.set(gram, available - 1);
			shared++;
		}
	}
	return (2 * shared) / (a.length - 1 + (b.length - 1));
}
