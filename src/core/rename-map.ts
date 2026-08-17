import { isAncestorOrSelf, normalizePath, pathSegments } from './paths';
import type { FolderProfileMap } from './types';

/**
 * Keeping the folder-profile map in step with the vault.
 *
 * The map is keyed by folder path, so any rename or move of a mapped folder — or of one of
 * its ancestors — silently orphans its entries unless they are rewritten. The shell wires
 * this to `app.vault.on('rename')`; the rewriting itself is pure, so it is fully testable
 * without a Vault.
 */

export interface RemapResult {
	map: FolderProfileMap;
	changed: boolean;
	/** `[oldKey, newKey]` for every entry that moved. Empty when nothing matched. */
	moved: [string, string][];
}

/**
 * Rewrite every key at or below `oldPath` to sit under `newPath`.
 *
 * Handles both the mapped folder itself being renamed and an ancestor being renamed, since
 * Obsidian fires a single rename event for the top-most moved folder and says nothing about
 * its descendants. Where the destination key already exists, the moved entry wins — the
 * folder that just arrived is the one the user acted on.
 */
export function remapFolderPaths(map: FolderProfileMap, oldPath: string, newPath: string): RemapResult {
	const from = normalizePath(oldPath);
	const to = normalizePath(newPath);
	if (from === to) return { map, changed: false, moved: [] };

	// The vault root is never renamed; treating `''` as a prefix would move every entry.
	if (from === '') return { map, changed: false, moved: [] };

	const fromDepth = pathSegments(from).length;
	const stationary: FolderProfileMap = {};
	const relocated: FolderProfileMap = {};
	const moved: [string, string][] = [];

	for (const [key, profileId] of Object.entries(map)) {
		if (!isAncestorOrSelf(from, key)) {
			stationary[key] = profileId;
			continue;
		}
		const tail = pathSegments(key).slice(fromDepth);
		const rewritten = [to, ...tail].filter((part) => part.length > 0).join('/');
		relocated[rewritten] = profileId;
		moved.push([key, rewritten]);
	}

	if (moved.length === 0) return { map, changed: false, moved: [] };
	// Relocated entries are applied last: the folder the user just moved wins any collision
	// with a pre-existing mapping at the destination path.
	return { map: { ...stationary, ...relocated }, changed: true, moved };
}

/**
 * Drop every mapping at or below a deleted folder. Wired to `app.vault.on('delete')` so a
 * deleted folder does not leave an entry that would silently reactivate if the path is
 * ever recreated for an unrelated purpose.
 */
export function removeFolderPaths(map: FolderProfileMap, deletedPath: string): RemapResult {
	const target = normalizePath(deletedPath);
	const next: FolderProfileMap = {};
	const moved: [string, string][] = [];
	let changed = false;

	for (const [key, profileId] of Object.entries(map)) {
		if (isAncestorOrSelf(target, key)) {
			changed = true;
			continue;
		}
		next[key] = profileId;
	}

	return changed ? { map: next, changed, moved } : { map, changed: false, moved };
}
