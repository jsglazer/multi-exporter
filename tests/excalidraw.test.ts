import { compressToBase64 } from 'lz-string';
import { describe, expect, it } from 'vitest';
import {
	computeBoardLayout,
	extractSceneSource,
	isExcalidrawNote,
	parseExcalidrawScene,
	resolveEmbedLinkTarget,
} from '../src/core/excalidraw';
import type { ExcalidrawElement } from '../src/core/excalidraw';

function embeddable(overrides: Partial<ExcalidrawElement> & { id: string }): ExcalidrawElement {
	return { type: 'embeddable', x: 0, y: 0, width: 100, height: 100, link: null, isDeleted: false, ...overrides };
}

describe('isExcalidrawNote', () => {
	it('recognises the plugin\'s own frontmatter flag', () => {
		expect(isExcalidrawNote({ 'excalidraw-plugin': 'parsed' })).toBe(true);
		expect(isExcalidrawNote({ 'excalidraw-plugin': 'raw' })).toBe(true);
	});

	it('is false for an ordinary note', () => {
		expect(isExcalidrawNote({ tags: ['drawing'] })).toBe(false);
		expect(isExcalidrawNote(undefined)).toBe(false);
	});
});

describe('extractSceneSource', () => {
	it('finds a compressed-json fence', () => {
		const markdown = '# Excalidraw Data\n\n%%\n## Drawing\n```compressed-json\nabc123\n```\n%%';
		expect(extractSceneSource(markdown)).toEqual({ compressed: true, body: 'abc123' });
	});

	it('finds a plain json fence when compression is off', () => {
		const markdown = '```json\n{"elements":[]}\n```';
		expect(extractSceneSource(markdown)).toEqual({ compressed: false, body: '{"elements":[]}' });
	});

	it('returns null when the note has no scene at all', () => {
		expect(extractSceneSource('## Elasticity\nJust a note.')).toBeNull();
	});
});

describe('parseExcalidrawScene', () => {
	it('decompresses a real lz-string payload, line breaks and all', () => {
		const scene = { elements: [embeddable({ id: 'a' })] };
		const compressed = compressToBase64(JSON.stringify(scene));
		// The vault file wraps the base64 blob across several lines; a naive decompress must
		// not choke on the embedded newlines the same way the file's own formatting does.
		const wrapped = compressed.replace(/(.{20})/g, '$1\n');
		expect(parseExcalidrawScene({ compressed: true, body: wrapped })).toEqual(scene);
	});

	it('parses an uncompressed payload verbatim', () => {
		const scene = { elements: [] };
		expect(parseExcalidrawScene({ compressed: false, body: JSON.stringify(scene) })).toEqual(scene);
	});

	it('throws on a payload that decompresses to nothing', () => {
		expect(() => parseExcalidrawScene({ compressed: true, body: 'not-valid-lz-string' })).toThrow();
	});

	it('throws when the JSON has no elements array', () => {
		expect(() => parseExcalidrawScene({ compressed: false, body: '{"foo":1}' })).toThrow();
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

	it('decodes an obsidian:// URL from a drag-and-drop embed', () => {
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

describe('computeBoardLayout', () => {
	it('positions boxes relative to the board\'s own top-left corner', () => {
		const layout = computeBoardLayout({
			elements: [
				embeddable({ id: 'a', x: 100, y: 200, width: 50, height: 60, link: '[[Elasticity]]' }),
				embeddable({ id: 'b', x: 300, y: 200, width: 40, height: 30, link: '[[CurveShifts]]' }),
			],
		});
		expect(layout.width).toBe(240); // 300 + 40 - 100
		expect(layout.height).toBe(60); // 200 + 60 - 200
		expect(layout.boxes).toEqual([
			{ id: 'a', x: 0, y: 0, width: 50, height: 60, linkTarget: 'Elasticity' },
			{ id: 'b', x: 200, y: 0, width: 40, height: 30, linkTarget: 'CurveShifts' },
		]);
	});

	it('ignores deleted elements and non-embeddable elements', () => {
		const layout = computeBoardLayout({
			elements: [
				embeddable({ id: 'a', link: '[[Kept]]' }),
				embeddable({ id: 'b', link: '[[Gone]]', isDeleted: true }),
				{ ...embeddable({ id: 'c', link: '[[NotABox]]' }), type: 'text' },
			],
		});
		expect(layout.boxes.map((box) => box.id)).toEqual(['a']);
	});

	it('returns an empty layout for a board with no embeddables', () => {
		expect(computeBoardLayout({ elements: [] })).toEqual({ width: 0, height: 0, boxes: [] });
	});

	it('keeps a box with no resolvable link as a placeholder-eligible box', () => {
		const layout = computeBoardLayout({ elements: [embeddable({ id: 'a', link: null })] });
		expect(layout.boxes[0]?.linkTarget).toBeNull();
	});
});
