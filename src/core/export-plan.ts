import { baseName, comparePathsHierarchyFirst, extensionOf, relativeTo, sanitizeFileName, stemName } from './paths';
import { resolveProfileForPath } from './profile-resolver';
import type { BulkExportMode, FolderProfileMap, Profile } from './types';

/**
 * Turning a selection into an ordered list of things to render, paginate and write.
 *
 * Entirely pure: given the same paths and settings it produces the same plan, in the same
 * order, with the same destinations. The shell does the walking of the vault and hands the
 * resulting path list in.
 */

/** Only markdown is exportable — this plugin renders Obsidian's DOM, not arbitrary files. */
export function isExportableNote(path: string): boolean {
	return extensionOf(path) === 'md';
}

/**
 * Sort and filter a folder's contents into export order: markdown only, **alphabetical by
 * folder hierarchy first, then file name**.
 */
export function orderNotes(paths: readonly string[]): string[] {
	return paths.filter(isExportableNote).sort(comparePathsHierarchyFirst);
}

export interface PlannedNote {
	/** Vault path of the note. */
	sourcePath: string;
	/** Profile this note will be rendered with. */
	profile: Profile;
	/** Destination path for Separate mode; `null` in Merged mode. */
	destination: string | null;
	/** Title used for the merged outline and for running heads. */
	title: string;
}

export interface ExportPlan {
	mode: BulkExportMode;
	notes: PlannedNote[];
	/** Merged mode only: the single output file. `null` in Separate mode. */
	mergedDestination: string | null;
	/**
	 * Merged mode only: the one profile driving the whole document. Merged export uses
	 * exactly one profile — the one chosen in the export modal — so per-folder defaults do
	 * not apply. `null` in Separate mode, where each note resolves its own.
	 */
	mergedProfile: Profile | null;
}

export interface SeparatePlanInput {
	paths: readonly string[];
	/** Folder the export was invoked on; the hierarchy below it is reproduced on disk. */
	sourceRoot: string;
	/** Absolute output directory chosen by the user. */
	outputDir: string;
	profiles: readonly Profile[];
	folderProfiles: FolderProfileMap;
	defaultProfileId: string;
	/**
	 * Profile chosen in the modal. When set it overrides folder defaults for every note;
	 * when `null` each note resolves its own folder default.
	 */
	overrideProfile: Profile | null;
}

/**
 * Separate mode: one PDF per note, **preserving the source folder hierarchy** under
 * `outputDir`. Each note resolves its own profile from the folder map unless the modal
 * overrode it.
 */
export function planSeparateExport(input: SeparatePlanInput): ExportPlan {
	const ordered = orderNotes(input.paths);
	const notes: PlannedNote[] = [];

	for (const sourcePath of ordered) {
		const profile =
			input.overrideProfile ??
			resolveProfileForPath(input.profiles, input.folderProfiles, sourcePath, input.defaultProfileId);
		if (profile === null) continue;

		const relative = relativeTo(input.sourceRoot, sourcePath);
		const segments = relative.split('/').filter((segment) => segment.length > 0);
		const fileName = `${sanitizeFileName(stemName(segments.pop() ?? baseName(sourcePath)))}.pdf`;
		const folders = segments.map((segment) => sanitizeFileName(segment));
		const destination = [trimTrailingSlash(input.outputDir), ...folders, fileName].join('/');

		notes.push({ sourcePath, profile, destination, title: stemName(sourcePath) });
	}

	return { mode: 'separate', notes, mergedDestination: null, mergedProfile: null };
}

export interface MergedPlanInput {
	paths: readonly string[];
	/** Absolute path of the single output file, including `.pdf`. */
	outputFile: string;
	/** The one profile for the whole merged document. */
	profile: Profile;
}

/**
 * Merged mode: a single PDF with continuous page numbering and a combined outline.
 *
 * Exactly one profile applies to the entire document. Per-folder profile defaults are a
 * Separate-mode and single-note concept: a merged document with per-note stylesheets and
 * page geometry is not a document, and continuous page numbering across it is meaningless.
 */
export function planMergedExport(input: MergedPlanInput): ExportPlan {
	const ordered = orderNotes(input.paths);
	const notes: PlannedNote[] = ordered.map((sourcePath) => ({
		sourcePath,
		profile: input.profile,
		destination: null,
		title: stemName(sourcePath),
	}));

	return {
		mode: 'merged',
		notes,
		mergedDestination: ensurePdfExtension(input.outputFile),
		mergedProfile: input.profile,
	};
}

/**
 * Destination for a single-note export into a chosen directory.
 *
 * `fileName` is the name typed in the export modal. It is a *file name*, not a path, so it
 * is sanitised as one segment and never run through `stemName` — `stemName` strips
 * everything after the last dot, which would silently turn `Q3 2026.final` into `Q3 2026`.
 * Only a trailing `.pdf` is removed, so typing the extension does not produce `x.pdf.pdf`.
 * An empty or whitespace-only name falls back to the note's own stem.
 */
export function singleNoteDestination(outputDir: string, sourcePath: string, fileName?: string): string {
	const typed = fileName === undefined ? '' : fileName.trim();
	const stem = typed === '' ? stemName(sourcePath) : stripPdfSuffix(typed);
	return `${trimTrailingSlash(outputDir)}/${sanitizeFileName(stem)}.pdf`;
}

function stripPdfSuffix(name: string): string {
	return name.toLowerCase().endsWith('.pdf') ? name.slice(0, -4) : name;
}

export function ensurePdfExtension(filePath: string): string {
	return filePath.toLowerCase().endsWith('.pdf') ? filePath : `${filePath}.pdf`;
}

function trimTrailingSlash(dir: string): string {
	return dir.length > 1 && dir.endsWith('/') ? dir.slice(0, -1) : dir;
}
