import { describe, expect, it } from 'vitest';
import {
	SNAPSHOT_PROPERTIES,
	extractFontFaceRules,
	fontFamiliesIn,
	pseudoContentText,
	serializeDeclarations,
} from '../src/core/style-snapshot';

describe('serializeDeclarations', () => {
	it('writes name: value pairs and skips properties the browser returned nothing for', () => {
		expect(
			serializeDeclarations([
				['font-family', '"Virgil"'],
				['font-size', '13px'],
				['text-decoration-thickness', ''],
			]),
		).toBe('font-family: "Virgil"; font-size: 13px;');
	});
});

describe('SNAPSHOT_PROPERTIES', () => {
	it('copies what a snippet styling an embed sets, and never the used box size', () => {
		for (const name of ['font-family', 'font-size', 'line-height', 'text-align', 'text-decoration-line', 'margin-bottom', 'color']) {
			expect(SNAPSHOT_PROPERTIES).toContain(name);
		}
		expect(SNAPSHOT_PROPERTIES).not.toContain('width');
		expect(SNAPSHOT_PROPERTIES).not.toContain('height');
	});

	it('lists longhands only, since Chromium reads shorthands back as empty strings', () => {
		for (const shorthand of ['margin', 'padding', 'border', 'font', 'background', 'flex', 'text-decoration', 'list-style']) {
			expect(SNAPSHOT_PROPERTIES).not.toContain(shorthand);
		}
	});
});

describe('pseudoContentText', () => {
	it('is null for a pseudo-element that generates no box', () => {
		expect(pseudoContentText('none')).toBeNull();
		expect(pseudoContentText('normal')).toBeNull();
		expect(pseudoContentText('')).toBeNull();
	});

	it("reads a quoted string, including the canvas node's single-space spacers", () => {
		expect(pseudoContentText('" "')).toBe(' ');
		expect(pseudoContentText('"→"')).toBe('→');
		expect(pseudoContentText("'a \\' b'")).toBe("a ' b");
	});

	it('keeps a box with no text for content it cannot reproduce statically', () => {
		expect(pseudoContentText('counter(item)')).toBe('');
		expect(pseudoContentText('attr(data-x)')).toBe('');
	});
});

describe('fontFamiliesIn', () => {
	it('splits and unquotes a computed font-family stack', () => {
		expect(fontFamiliesIn('"Virgil", "Segoe UI", sans-serif')).toEqual(['Virgil', 'Segoe UI', 'sans-serif']);
		expect(fontFamiliesIn('Virgil')).toEqual(['Virgil']);
	});
});

describe('extractFontFaceRules', () => {
	it('pulls whole @font-face blocks out of a stylesheet and nothing else', () => {
		const css = 'text { fill: red } @font-face { font-family: "Virgil"; src: url(data:font/woff2;base64,AAA) } .x{}';
		expect(extractFontFaceRules(css)).toEqual(['@font-face { font-family: "Virgil"; src: url(data:font/woff2;base64,AAA) }']);
		expect(extractFontFaceRules('.x {}')).toEqual([]);
	});
});
