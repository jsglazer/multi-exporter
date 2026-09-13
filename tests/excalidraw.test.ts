import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isExcalidrawNote, resolveEmbedLinkTarget } from '../src/core/excalidraw';

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
});
