/**
 * Freezing how the running app styles a subtree, so it prints the same in the guest webview.
 *
 * The guest is an isolated `about:blank` document: it gets this plugin's base stylesheet and the
 * profile's, and nothing of Obsidian's theme, the user's enabled CSS snippets, or any plugin's
 * stylesheet. For ordinary prose that isolation is the point — the profile decides how a page
 * looks. A note embedded on an Excalidraw board is the exception: the user asked for a replica of
 * the canvas as it appears on screen, and on screen that box is styled by the theme and by
 * whatever snippet targets `.canvas-node-container` (fonts, sizes, heading rules). So the shell
 * lets the live app style the box, reads the result back with `getComputedStyle`, and writes it
 * onto each element as an inline style. This module is the pure half: which properties to copy,
 * and how to read the values the browser hands back.
 */

/**
 * The computed properties copied onto each element.
 *
 * Deliberately not "every property": `width`/`height` are left to layout (their computed value is
 * the used size, and freezing it would stop a box from reflowing if a font differs by a pixel in
 * the guest), and transitions, cursors and the like print nothing. Longhands only — shorthands
 * read back from `getComputedStyle` as empty strings in Chromium.
 */
export const SNAPSHOT_PROPERTIES: readonly string[] = [
	'display',
	'box-sizing',
	'flex-direction',
	'flex-grow',
	'flex-shrink',
	'flex-basis',
	'align-items',
	'justify-content',
	'row-gap',
	'column-gap',
	'min-height',
	'max-height',
	'max-width',
	'margin-top',
	'margin-right',
	'margin-bottom',
	'margin-left',
	'padding-top',
	'padding-right',
	'padding-bottom',
	'padding-left',
	'border-top-width',
	'border-right-width',
	'border-bottom-width',
	'border-left-width',
	'border-top-style',
	'border-right-style',
	'border-bottom-style',
	'border-left-style',
	'border-top-color',
	'border-right-color',
	'border-bottom-color',
	'border-left-color',
	'border-top-left-radius',
	'border-top-right-radius',
	'border-bottom-right-radius',
	'border-bottom-left-radius',
	'background-color',
	'color',
	'opacity',
	'font-family',
	'font-size',
	'font-weight',
	'font-style',
	'font-variant-caps',
	'line-height',
	'letter-spacing',
	'word-spacing',
	'text-align',
	'text-indent',
	'text-transform',
	'text-decoration-line',
	'text-decoration-style',
	'text-decoration-color',
	'text-decoration-thickness',
	'text-underline-offset',
	'vertical-align',
	'white-space',
	'overflow-wrap',
	'word-break',
	'list-style-type',
	'list-style-position',
	'border-collapse',
];

/** One `name: value;` declaration list, skipping properties the browser returned nothing for. */
export function serializeDeclarations(entries: Iterable<readonly [string, string]>): string {
	const parts: string[] = [];
	for (const [name, value] of entries) {
		if (value === '') continue;
		parts.push(`${name}: ${value};`);
	}
	return parts.join(' ');
}

/**
 * The text a `::before`/`::after` draws, from its computed `content`, or `null` when it draws no
 * box at all.
 *
 * `none`/`normal` generate nothing. A quoted string — including `" "`, which is how Obsidian's
 * canvas node builds its vertical-centring spacers — generates a box with that text. Anything
 * else (`counter()`, `attr()`, `url()`) still generates a box, but its text cannot be reproduced
 * statically, so the box is kept (it may carry margins or size) and the text left empty.
 */
export function pseudoContentText(content: string): string | null {
	const trimmed = content.trim();
	if (trimmed === '' || trimmed === 'none' || trimmed === 'normal') return null;
	const quoted = /^(["'])((?:\\.|(?!\1).)*)\1$/.exec(trimmed);
	if (quoted === null) return '';
	return (quoted[2] ?? '').replace(/\\(.)/g, '$1');
}

/**
 * Every family named in a computed `font-family` stack, unquoted, in order.
 *
 * `"Virgil", "Segoe UI", sans-serif` -> `['Virgil', 'Segoe UI', 'sans-serif']`.
 */
export function fontFamiliesIn(stack: string): string[] {
	const families: string[] = [];
	for (const raw of stack.split(',')) {
		const family = raw.trim().replace(/^(["'])(.*)\1$/, '$2').trim();
		if (family !== '') families.push(family);
	}
	return families;
}

/** Every complete `@font-face { ... }` block in a stylesheet's text. */
export function extractFontFaceRules(css: string): string[] {
	return css.match(/@font-face\s*\{[^}]*\}/g) ?? [];
}
