import { describe, expect, it } from 'vitest';
import { isExcalidrawNote, resolveEmbedLinkTarget } from '../src/core/excalidraw';

describe('isExcalidrawNote', () => {
	it("recognises the plugin's own frontmatter flag", () => {
		expect(isExcalidrawNote({ 'excalidraw-plugin': 'parsed' })).toBe(true);
		expect(isExcalidrawNote({ 'excalidraw-plugin': 'raw' })).toBe(true);
	});

	it('is false for an ordinary note', () => {
		expect(isExcalidrawNote({ tags: ['drawing'] })).toBe(false);
		expect(isExcalidrawNote(undefined)).toBe(false);
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
