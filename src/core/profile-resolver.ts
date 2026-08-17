import { isAncestorOrSelf, normalizePath, parentFolder, pathSegments } from './paths';
import type { FolderProfileMap, Profile } from './types';

/**
 * Folder-level profile defaults.
 *
 * Folder metadata is a centralised path-prefix map in `data.json` — no `.folder-meta.json`
 * files, no folder notes, no vault pollution. Resolution is a nearest-ancestor lookup:
 * the deepest mapped folder that contains the file wins, and the vault root (`''`) is a
 * legal key that acts as a catch-all.
 */

export interface ProfileResolution {
	profileId: string;
	/** The map key that matched, or `null` when nothing did and the fallback was used. */
	matchedFolder: string | null;
}

/**
 * Nearest-ancestor lookup for `filePath`. Walks from the file's own folder up to the vault
 * root and returns the first mapping found, so a deep mapping always beats a shallow one.
 */
export function resolveFolderProfile(
	map: FolderProfileMap,
	filePath: string,
	fallbackProfileId: string,
): ProfileResolution {
	let folder = parentFolder(filePath);
	for (;;) {
		const hit = map[folder];
		if (hit !== undefined) return { profileId: hit, matchedFolder: folder };
		if (folder === '') break;
		folder = parentFolder(folder);
	}
	return { profileId: fallbackProfileId, matchedFolder: null };
}

/**
 * Resolve to a real profile record, falling back to `settings.defaultProfileId` and then to
 * the first profile. A map entry pointing at a deleted profile resolves as if unmapped
 * rather than throwing — settings edited by hand should never break an export.
 */
export function resolveProfileForPath(
	profiles: readonly Profile[],
	map: FolderProfileMap,
	filePath: string,
	defaultProfileId: string,
): Profile | null {
	if (profiles.length === 0) return null;
	const byId = new Map(profiles.map((profile) => [profile.id, profile]));
	const resolution = resolveFolderProfile(map, filePath, defaultProfileId);
	return byId.get(resolution.profileId) ?? byId.get(defaultProfileId) ?? profiles[0] ?? null;
}

/** Set a folder's default profile. `''` sets the vault-wide default mapping. */
export function setFolderProfile(map: FolderProfileMap, folder: string, profileId: string): FolderProfileMap {
	return { ...map, [normalizePath(folder)]: profileId };
}

export function clearFolderProfile(map: FolderProfileMap, folder: string): FolderProfileMap {
	const key = normalizePath(folder);
	if (!(key in map)) return map;
	const next = { ...map };
	delete next[key];
	return next;
}

/**
 * Drop entries whose profile id no longer exists. Called after a profile is deleted so the
 * map does not accumulate dangling ids.
 */
export function pruneFolderProfiles(map: FolderProfileMap, profiles: readonly Profile[]): FolderProfileMap {
	const live = new Set(profiles.map((profile) => profile.id));
	const next: FolderProfileMap = {};
	for (const [folder, profileId] of Object.entries(map)) {
		if (live.has(profileId)) next[folder] = profileId;
	}
	return next;
}

/** Mappings that apply somewhere at or below `folder`, deepest first. Used by the UI. */
export function mappingsUnder(map: FolderProfileMap, folder: string): [string, string][] {
	return Object.entries(map)
		.filter(([key]) => isAncestorOrSelf(folder, key))
		.sort((a, b) => pathSegments(b[0]).length - pathSegments(a[0]).length || (a[0] < b[0] ? -1 : 1));
}
