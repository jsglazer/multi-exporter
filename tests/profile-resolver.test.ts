import { describe, expect, it } from 'vitest';
import {
	clearFolderProfile,
	mappingsUnder,
	pruneFolderProfiles,
	resolveFolderProfile,
	resolveProfileForPath,
	setFolderProfile,
} from '../src/core/profile-resolver';
import { createDefaultProfiles } from '../src/core/profiles';
import type { FolderProfileMap } from '../src/core/types';

/**
 * Deterministic test requirement: "Unit-test the path-prefix nearest-ancestor profile
 * resolver with mock data maps."
 */
describe('resolveFolderProfile', () => {
	const map: FolderProfileMap = {
		'': 'article',
		Research: 'manuscript',
		'Research/Data': 'dataview',
		'Research/Data/Archive': 'article',
	};

	it('uses the deepest mapping that contains the file', () => {
		expect(resolveFolderProfile(map, 'Research/Data/table.md', 'fallback')).toEqual({
			profileId: 'dataview',
			matchedFolder: 'Research/Data',
		});
	});

	it('walks up to a shallower mapping when the immediate folder is unmapped', () => {
		expect(resolveFolderProfile(map, 'Research/Chapters/Two/notes.md', 'fallback')).toEqual({
			profileId: 'manuscript',
			matchedFolder: 'Research',
		});
	});

	it('treats the empty key as a vault-wide mapping', () => {
		expect(resolveFolderProfile(map, 'Inbox/clip.md', 'fallback')).toEqual({
			profileId: 'article',
			matchedFolder: '',
		});
	});

	it('lets a deeper mapping override a shallower one', () => {
		expect(resolveFolderProfile(map, 'Research/Data/Archive/old.md', 'fallback').profileId).toBe('article');
	});

	it('falls back when nothing matches', () => {
		expect(resolveFolderProfile({ Research: 'manuscript' }, 'Inbox/a.md', 'fallback')).toEqual({
			profileId: 'fallback',
			matchedFolder: null,
		});
	});

	// The bug this guards: a naive `startsWith` prefix match makes `Research/Data` an
	// ancestor of `Research/Database/x.md`, which is wrong and near-invisible in use.
	it('does not treat a partial segment as an ancestor', () => {
		const partial: FolderProfileMap = { 'Research/Data': 'dataview' };
		expect(resolveFolderProfile(partial, 'Research/Database/notes.md', 'fallback').matchedFolder).toBeNull();
	});

	it('is unaffected by leading, trailing or duplicated slashes', () => {
		expect(resolveFolderProfile(map, '/Research//Data/table.md', 'fallback').profileId).toBe('dataview');
	});

	it('resolves a file at the vault root against the empty key', () => {
		expect(resolveFolderProfile(map, 'top.md', 'fallback').matchedFolder).toBe('');
	});
});

describe('resolveProfileForPath', () => {
	const profiles = createDefaultProfiles();

	it('returns the mapped profile record', () => {
		const profile = resolveProfileForPath(profiles, { Papers: 'manuscript' }, 'Papers/one.md', 'article');
		expect(profile?.id).toBe('manuscript');
	});

	// Settings are hand-editable and survive across versions, so a stale id must degrade
	// rather than break an export.
	it('falls back when a mapping points at a deleted profile', () => {
		const profile = resolveProfileForPath(profiles, { Papers: 'ghost' }, 'Papers/one.md', 'dataview');
		expect(profile?.id).toBe('dataview');
	});

	it('returns null only when there are no profiles at all', () => {
		expect(resolveProfileForPath([], {}, 'a.md', 'article')).toBeNull();
	});
});

describe('map editing', () => {
	it('sets and clears normalised keys', () => {
		const set = setFolderProfile({}, '/Research/Data/', 'dataview');
		expect(set).toEqual({ 'Research/Data': 'dataview' });
		expect(clearFolderProfile(set, 'Research/Data')).toEqual({});
	});

	it('returns the same object when clearing a key that is not there', () => {
		const map = { Research: 'manuscript' };
		expect(clearFolderProfile(map, 'Other')).toBe(map);
	});

	it('prunes entries whose profile no longer exists', () => {
		const pruned = pruneFolderProfiles({ A: 'article', B: 'ghost' }, createDefaultProfiles());
		expect(pruned).toEqual({ A: 'article' });
	});

	it('lists mappings deepest first', () => {
		const map: FolderProfileMap = { '': 'article', 'A/B': 'dataview', A: 'manuscript' };
		expect(mappingsUnder(map, '').map(([folder]) => folder)).toEqual(['A/B', 'A', '']);
	});
});
