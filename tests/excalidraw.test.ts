import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	FONT_SAMPLE_TEXT,
	cssPixels,
	excalidrawFontIds,
	isExcalidrawNote,
	resolveEmbedLinkTarget,
	resolveExportTarget,
} from '../src/core/excalidraw';

describe('isExcalidrawNote', () => {
	it('recognises the .excalidraw.md filename convention regardless of frontmatter', () => {
		expect(isExcalidrawNote('Draw/Econ Layout.excalidraw.md', undefined)).toBe(true);
		expect(isExcalidrawNote('Draw/Econ Layout.excalidraw.md', {})).toBe(true);
	});

	it('recognises a legacy raw .excalidraw file', () => {
		expect(isExcalidrawNote('Draw/Old.excalidraw', undefined)).toBe(true);
	});

	it("recognises the plugin's own frontmatter flag on any truthy value, not just specific strings", () => {
		expect(isExcalidrawNote('Notes/Whatever.md', { 'excalidraw-plugin': 'parsed' })).toBe(true);
		expect(isExcalidrawNote('Notes/Whatever.md', { 'excalidraw-plugin': 'raw' })).toBe(true);
		expect(isExcalidrawNote('Notes/Whatever.md', { 'excalidraw-plugin': true })).toBe(true);
	});

	it('is false for an ordinary note', () => {
		expect(isExcalidrawNote('Notes/Whatever.md', { tags: ['drawing'] })).toBe(false);
		expect(isExcalidrawNote('Notes/Whatever.md', undefined)).toBe(false);
	});
});

describe('cssPixels', () => {
	it("reads Excalidraw's inline-style box size as well as a bare attribute number", () => {
		expect(cssPixels('400px')).toBe(400);
		expect(cssPixels(' 420 ')).toBe(420);
		expect(cssPixels('13.5px')).toBe(13.5);
	});

	it('is null — not 0 — when there is no usable size, so the caller falls through to the next source', () => {
		expect(cssPixels(null)).toBeNull();
		expect(cssPixels(undefined)).toBeNull();
		expect(cssPixels('')).toBeNull();
		expect(cssPixels('0')).toBeNull();
		expect(cssPixels('100%')).toBeNull();
		expect(cssPixels('auto')).toBeNull();
	});
});

describe('excalidrawFontIds', () => {
	it("maps Excalidraw's own families to their scene font ids, once each, and ignores other fonts", () => {
		expect(excalidrawFontIds(['Virgil', 'Segoe UI', 'sans-serif', 'Virgil', 'Excalifont'])).toEqual([1, 5]);
		expect(excalidrawFontIds(['Helvetica', 'Inter'])).toEqual([]);
	});
});

describe('FONT_SAMPLE_TEXT', () => {
	it('covers printable ASCII and the typographic characters notes commonly use', () => {
		for (const ch of ['A', 'z', '0', '>', '<', '=', '(', '.', 'é', '–', '—', '’', '“', '•', '−', '⇒', '→']) {
			expect(FONT_SAMPLE_TEXT).toContain(ch);
		}
	});
});

describe('resolveExportTarget', () => {
	it('exports the board, not an embedded note Excalidraw made the active file', () => {
		expect(resolveExportTarget('Draw/Elasticity.md', ['Econ Layout.excalidraw.md'])).toBe('Econ Layout.excalidraw.md');
	});

	it('prefers the outermost board when boards are nested (innermost first)', () => {
		expect(resolveExportTarget('Draw/Elasticity.md', ['Inner.excalidraw.md', 'Outer.excalidraw.md'])).toBe(
			'Outer.excalidraw.md',
		);
	});

	it('keeps the active file when no board encloses it', () => {
		expect(resolveExportTarget('Draw/Elasticity.md', [])).toBe('Draw/Elasticity.md');
		expect(resolveExportTarget(null, [])).toBeNull();
	});
});

describe('resolveEmbedLinkTarget', () => {
	it('reads a plain wikilink', () => {
		expect(resolveEmbedLinkTarget('[[CurveShifts]]')).toBe('CurveShifts');
	});

	it('reads a wikilink with an alias or heading, ignoring the suffix', () => {
		expect(resolveEmbedLinkTarget('[[Note|Alias]]')).toBe('Note');
		expect(resolveEmbedLinkTarget('[[Note#Heading]]')).toBe('Note');
	});

	it('decodes an obsidian:// URL, as Excalidraw renders a note-embed box\'s link', () => {
		const url = 'obsidian://open?vault=VaultSchar&file=Classes%2FDraw%2FElasticity.md';
		expect(resolveEmbedLinkTarget(url)).toBe('Classes/Draw/Elasticity');
	});

	it('returns null for a link that is neither', () => {
		expect(resolveEmbedLinkTarget('https://example.com')).toBeNull();
		expect(resolveEmbedLinkTarget(null)).toBeNull();
		expect(resolveEmbedLinkTarget(undefined)).toBeNull();
		expect(resolveEmbedLinkTarget('')).toBeNull();
	});
});

/**
 * `shell/excalidraw-render.ts` imports `obsidian` and so cannot be unit-tested directly (the
 * project's usual core/shell boundary) — but the one call in it that is easy to quietly break
 * by "simplifying" a long argument list deserves a guard anyway, since it already broke once.
 * `createSVG`'s 7th positional argument (`convertMarkdownLinksToObsidianURLs`) must stay `true`:
 * false — the plugin's own default — renders a note-embed box's link as the literal wikilink
 * text instead of an obsidian:// URL, which silently stops every swap in this file from firing
 * at all, with no error anywhere. Asserted by reading the source as text rather than executing
 * it, the same reason `guest-scripts.test.ts` parses instead of running.
 */
describe('excalidraw-render source guard', () => {
	const source = readFileSync(join(__dirname, '..', 'src', 'shell', 'excalidraw-render.ts'), 'utf8');

	it('requests the obsidian:// link form from createSVG, not the wikilink-text default', () => {
		const call = /automate\.createSVG\(([^)]*)\)/.exec(source);
		expect(call).not.toBeNull();
		const args = (call?.[1] ?? '').split(',').map((arg) => arg.trim());
		// file.path, embedFont, exportSettings, loader, theme, padding, convertMarkdownLinksToObsidianURLs
		expect(args[6]).toBe('true');
	});

	// A user's CSS snippet for embeds on a board is written against Obsidian's canvas-file-node DOM
	// (e.g. `.canvas-node-container .markdown-rendered h2`). Renaming or dropping a level here
	// silently prints every embed unstyled, so the chain is pinned.
	it("renders an embedded note inside the canvas file node's class chain", () => {
		for (const cls of [
			"'canvas-node-container'",
			"'canvas-node-content markdown-embed'",
			"'markdown-embed-content'",
			"'markdown-preview-view markdown-rendered'",
			"'markdown-preview-sizer markdown-preview-section'",
		]) {
			expect(source).toContain(`cls: ${cls}`);
		}
		expect(source).toMatch(/MarkdownRenderer\.render\(app, targetMarkdown, node\.sizer,/);
		expect(source).toContain('freezeComputedStyles(');
	});

	// Excalidraw sizes an embed's foreignObject by inline style, not attributes; reading only the
	// attributes sized every canvas node 0px wide (Econ Layout.excalidraw 5.pdf, 2026-09-13).
	it("sizes a box from the foreignObject's inline style when it has no width/height attributes", () => {
		expect(source).toMatch(/cssPixels\(foreignObject\.style\.width\)/);
		expect(source).toMatch(/cssPixels\(foreignObject\.style\.height\)/);
		expect(source).not.toMatch(/foreignObject\.getAttribute\('(width|height)'\) \?\? '0'/);
	});
});

/**
 * Same reasoning, for `main.ts`: both "active note" commands must resolve their target through
 * `activeExportTarget()`, never `getActiveFile()` directly — a direct call silently exports an
 * embedded note instead of the Excalidraw board around it (Elasticity 5.pdf, 2026-09-13).
 */
describe('main.ts export-target guard', () => {
	const source = readFileSync(join(__dirname, '..', 'src', 'main.ts'), 'utf8')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/\/\/.*$/gm, '');

	it('calls getActiveFile() only inside activeExportTarget()', () => {
		expect(source.match(/getActiveFile\(\)/g) ?? []).toHaveLength(1);
		expect(source).toMatch(/activeExportTarget\(\): TFile \| null \{[^}]*getActiveFile\(\)/);
		expect(source.match(/this\.activeExportTarget\(\)/g) ?? []).toHaveLength(2);
	});
});
