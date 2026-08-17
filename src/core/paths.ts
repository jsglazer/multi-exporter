/**
 * Vault-path arithmetic. Pure string work — no `path` module, no filesystem, so this runs
 * identically on any platform and in any test.
 *
 * Vault paths are always POSIX-style, relative to the vault root, with no leading or
 * trailing slash. The vault root itself is the empty string.
 */

/** Collapse `\` -> `/`, drop `.` segments, and strip leading/trailing slashes. */
export function normalizePath(input: string): string {
	const segments = input
		.replace(/\\/g, '/')
		.split('/')
		.filter((segment) => segment.length > 0 && segment !== '.');
	return segments.join('/');
}

export function pathSegments(input: string): string[] {
	const normalized = normalizePath(input);
	return normalized === '' ? [] : normalized.split('/');
}

/** Parent folder of a path; `''` for anything at the vault root. */
export function parentFolder(input: string): string {
	const segments = pathSegments(input);
	segments.pop();
	return segments.join('/');
}

export function baseName(input: string): string {
	const segments = pathSegments(input);
	return segments.length === 0 ? '' : (segments[segments.length - 1] ?? '');
}

/** File name without its final extension. `notes/a.b.md` -> `a.b`. */
export function stemName(input: string): string {
	const base = baseName(input);
	const dot = base.lastIndexOf('.');
	return dot <= 0 ? base : base.slice(0, dot);
}

export function extensionOf(input: string): string {
	const base = baseName(input);
	const dot = base.lastIndexOf('.');
	return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

export function joinPath(...parts: string[]): string {
	return parts
		.map((part) => normalizePath(part))
		.filter((part) => part.length > 0)
		.join('/');
}

/**
 * True when `folder` is `path` itself or one of its ancestors. Segment-wise, so
 * `Notes/Sub` is not treated as an ancestor of `Notes/Subterranean/x.md`.
 */
export function isAncestorOrSelf(folder: string, path: string): boolean {
	const folderSegments = pathSegments(folder);
	const pathSegs = pathSegments(path);
	if (folderSegments.length > pathSegs.length) return false;
	for (let i = 0; i < folderSegments.length; i++) {
		if (folderSegments[i] !== pathSegs[i]) return false;
	}
	return true;
}

/** `path` expressed relative to `root`. Returns `path` unchanged if it is not under `root`. */
export function relativeTo(root: string, path: string): string {
	if (!isAncestorOrSelf(root, path)) return normalizePath(path);
	const rootLength = pathSegments(root).length;
	return pathSegments(path).slice(rootLength).join('/');
}

/**
 * Ordering for bulk export: **folder hierarchy first, then file name**.
 *
 * Directory portions are compared segment by segment, so a file sitting directly in `A`
 * sorts before anything inside `A/B`, and `A/B` sorts before `A/C`. Only when two files
 * share a directory does the file name decide. Comparison is code-point based rather than
 * locale-aware, because a locale-sensitive collator would make the output order depend on
 * the machine running the export.
 */
export function comparePathsHierarchyFirst(a: string, b: string): number {
	const dirA = pathSegments(parentFolder(a));
	const dirB = pathSegments(parentFolder(b));
	const shared = Math.min(dirA.length, dirB.length);
	for (let i = 0; i < shared; i++) {
		const segA = dirA[i] ?? '';
		const segB = dirB[i] ?? '';
		if (segA !== segB) return segA < segB ? -1 : 1;
	}
	if (dirA.length !== dirB.length) return dirA.length - dirB.length;
	const nameA = baseName(a);
	const nameB = baseName(b);
	if (nameA === nameB) return 0;
	return nameA < nameB ? -1 : 1;
}

/** Characters that are unsafe in a file name on macOS/Windows, plus control characters. */
// Control characters really are unsafe in a file name; matching them is the point.
// eslint-disable-next-line no-control-regex
const UNSAFE_FILENAME = /[<>:"/\\|?*\u0000-\u001f]/g;

/** Make `name` safe to use as a single path segment. Never returns an empty string. */
export function sanitizeFileName(name: string): string {
	const cleaned = name
		.replace(UNSAFE_FILENAME, '-')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/^\.+/, '')
		.replace(/\.+$/, '');
	return cleaned.length === 0 ? 'untitled' : cleaned;
}
