import { describe, expect, it } from 'vitest';
import { remapFolderPaths, removeFolderPaths } from '../src/core/rename-map';
import type { FolderProfileMap } from '../src/core/types';

/**
 * Reviewer criterion: `app.vault.on('rename')` is registered in the plugin shell and updates
 * the `data.json` settings keys. The registration lives in `src/main.ts`; the rewriting it
 * performs is this pure function, tested here.
 *
 * Without it the map silently rots the first time a folder is reorganised — which is the
 * failure you notice weeks later, when an export quietly uses the wrong profile.
 */
describe('remapFolderPaths', () => {
	it('rewrites the renamed folder itself', () => {
		const map: FolderProfileMap = { Research: 'manuscript' };
		const result = remapFolderPaths(map, 'Research', 'Thesis');
		expect(result.changed).toBe(true);
		expect(result.map).toEqual({ Thesis: 'manuscript' });
		expect(result.moved).toEqual([['Research', 'Thesis']]);
	});

	// Obsidian fires one event for the top-most moved folder and says nothing about its
	// descendants, so this has to be a prefix rewrite rather than a single-key swap.
	it('rewrites every descendant when an ancestor is renamed', () => {
		const map: FolderProfileMap = {
			Research: 'manuscript',
			'Research/Data': 'dataview',
			'Research/Data/Archive': 'article',
		};
		const result = remapFolderPaths(map, 'Research', 'Thesis');
		expect(result.map).toEqual({
			Thesis: 'manuscript',
			'Thesis/Data': 'dataview',
			'Thesis/Data/Archive': 'article',
		});
	});

	it('handles a move into a different parent', () => {
		const map: FolderProfileMap = { 'A/B': 'dataview', 'A/B/C': 'article' };
		const result = remapFolderPaths(map, 'A/B', 'X/Y/B');
		expect(result.map).toEqual({ 'X/Y/B': 'dataview', 'X/Y/B/C': 'article' });
	});

	it('leaves unrelated entries untouched', () => {
		const map: FolderProfileMap = { Research: 'manuscript', Inbox: 'article' };
		expect(remapFolderPaths(map, 'Research', 'Thesis').map.Inbox).toBe('article');
	});

	// The same partial-segment hazard as the resolver: `Research` must not be an ancestor of
	// `Researchers`.
	it('does not rewrite a folder that merely shares a name prefix', () => {
		const map: FolderProfileMap = { Researchers: 'article' };
		const result = remapFolderPaths(map, 'Research', 'Thesis');
		expect(result.changed).toBe(false);
		expect(result.map).toBe(map);
	});

	it('reports no change when nothing matched', () => {
		const map: FolderProfileMap = { Inbox: 'article' };
		const result = remapFolderPaths(map, 'Research', 'Thesis');
		expect(result.changed).toBe(false);
		expect(result.map).toBe(map);
	});

	it('reports no change when the path did not actually change', () => {
		const map: FolderProfileMap = { Research: 'manuscript' };
		expect(remapFolderPaths(map, 'Research', 'Research').changed).toBe(false);
	});

	it('lets the moved folder win a collision at the destination', () => {
		const map: FolderProfileMap = { A: 'article', B: 'manuscript' };
		const result = remapFolderPaths(map, 'B', 'A');
		expect(result.map).toEqual({ A: 'manuscript' });
	});

	// `''` is a legal key meaning the vault root; treating it as a prefix would move every
	// entry in the map.
	it('never treats the vault root as a renamed prefix', () => {
		const map: FolderProfileMap = { '': 'article', Research: 'manuscript' };
		expect(remapFolderPaths(map, '', 'Anything').changed).toBe(false);
	});

	it('normalises slashes on both sides', () => {
		const map: FolderProfileMap = { 'Research/Data': 'dataview' };
		expect(remapFolderPaths(map, '/Research/', 'Thesis/').map).toEqual({ 'Thesis/Data': 'dataview' });
	});
});

describe('removeFolderPaths', () => {
	it('drops the folder and everything beneath it', () => {
		const map: FolderProfileMap = {
			Research: 'manuscript',
			'Research/Data': 'dataview',
			Inbox: 'article',
		};
		const result = removeFolderPaths(map, 'Research');
		expect(result.changed).toBe(true);
		expect(result.map).toEqual({ Inbox: 'article' });
	});

	it('reports no change when nothing matched', () => {
		const map: FolderProfileMap = { Inbox: 'article' };
		const result = removeFolderPaths(map, 'Research');
		expect(result.changed).toBe(false);
		expect(result.map).toBe(map);
	});
});
