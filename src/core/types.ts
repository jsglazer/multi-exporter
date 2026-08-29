/**
 * Data shapes shared across the pure core.
 *
 * A profile is *data, not code*: nothing here or anywhere else branches on a profile's
 * name. Every behavioural difference reads a flag off the profile record, so a
 * user-created profile is indistinguishable from a shipped one.
 */

export type AnnotationMode = 'gutter' | 'endnotes' | 'off';

export type PageSize = 'Letter' | 'Legal' | 'Tabloid' | 'A4' | 'A5';

/**
 * How `counter(page)` and `counter(pages)` run through a **merged** export.
 *
 * `per-note` restarts both at each note, so a ten-note merge reads `1 of 6`, `2 of 6`, …
 * then `1 of 12` again. `continuous` numbers the whole PDF 1…N. Single-note and Separate
 * exports have one document either way, so this changes nothing for them.
 */
export type PageNumbering = 'per-note' | 'continuous';

/** Which page constraint fit-to-page measures against. See `PageConfig.fitAxis`. */
export type FitAxis = 'width' | 'height' | 'both';

export interface PageMargins {
	top: string;
	right: string;
	bottom: string;
	left: string;
}

/** Content for a single CSS Paged Media margin box. */
export interface MarginBoxContent {
	/** Raw CSS `content:` value, e.g. `counter(page)` or `"Chapter " string(chapter)`. */
	content: string;
}

export interface PageFurniture {
	topLeft?: MarginBoxContent;
	topCenter?: MarginBoxContent;
	topRight?: MarginBoxContent;
	bottomLeft?: MarginBoxContent;
	bottomCenter?: MarginBoxContent;
	bottomRight?: MarginBoxContent;
}

export interface PageConfig {
	size: PageSize;
	orientation: 'portrait' | 'landscape';
	margins: PageMargins;
	/** Furniture on every page unless overridden below. */
	furniture: PageFurniture;
	/** Recto (right-hand) overrides; empty means "same as `furniture`". */
	rectoFurniture?: PageFurniture;
	/** Verso (left-hand) overrides; empty means "same as `furniture`". */
	versoFurniture?: PageFurniture;
	/** Suppress all furniture on the first page (`@page :first`). */
	suppressFirstPageFurniture: boolean;
	/**
	 * Keep a heading on the same page as the text that follows it.
	 *
	 * Emits `break-after: avoid` for `h1`–`h6`. `orphans` and `widows` below cannot express
	 * this: they count lines *within* one block, and a heading stranded at the foot of a page
	 * is a break *between* two blocks.
	 */
	keepHeadingsWithText: boolean;
	/**
	 * Whether a merged export restarts page numbering at each note.
	 *
	 * Not expressible in CSS: paged.js sets `pages` once from the chunker's final count, and
	 * CSS Paged Media has no per-section total. It is applied as counter scopes on the
	 * paginated pages instead — see `core/page-numbering.ts`.
	 */
	pageNumbering: PageNumbering;
	/**
	 * Shrink the printed page until its content fits inside the page box.
	 *
	 * The escape hatch for content that is simply too big for the paper — a wide table, a
	 * full-resolution screenshot, a Mermaid diagram with twenty nodes. `BASE_DOCUMENT_CSS`
	 * caps such things at 100% of the text column, but a `min-width` a plugin set itself
	 * beats a `max-width`, and paged.js then moves the whole unbreakable element to the next
	 * page rather than shrinking it — which reads as "the export lost half the note".
	 *
	 * On, the export measures the worst overflow on the finished pages and prints at exactly
	 * the scale that brings it inside the box; off, `printScale` is used verbatim. Either way
	 * it is Chromium's own print scale, applied to the whole document, so text and figures
	 * keep their relative sizes.
	 */
	fitToPage: boolean;
	/**
	 * Which overflow `fitToPage` measures.
	 *
	 * The print scale is a **single uniform number** — Chromium has no way to squeeze one axis
	 * and not the other — so this does not choose how to scale, it chooses what to scale *for*.
	 * `width` looks only at content wider than the text column, `height` only at content taller
	 * than the page box, and `both` at whichever is worse.
	 *
	 * The distinction matters because the two constraints disagree. A wide table wants width
	 * fitting; a tall diagram wants height fitting; and `both` on a document with one of each
	 * shrinks everything to satisfy the harsher of the two, which is often much more than the
	 * page actually needed.
	 */
	fitAxis: FitAxis;
	/** Print scale as a percentage, used when `fitToPage` is off. 100 is unscaled. */
	printScale: number;
	orphans: number;
	widows: number;
}

/** The behavioural surface of a profile. Code reads these; it never reads `name`. */
export interface ProfileFlags {
	/** Treat wikilinks whose target is a known cite key as citations. */
	resolveCitations: boolean;
	/** Append a `zotero-manager`-formatted bibliography. */
	emitBibliography: boolean;
	/** Fetch remote images and resolve local ones to data URIs before pagination. */
	inlineImages: boolean;
	/** Opt-in secondary scan for Pandoc-style `[@key]` citations in text nodes. */
	pandocCitationScan: boolean;
	/** Run the `pdfs` (PDF Squeezer) CLI on the finished file when it is installed. */
	runSqueezer: boolean;
	/** Optional `.pdfscp` profile file passed to `pdfs --profile`. */
	squeezerProfile?: string;
	/** Where `md-annotation` comments go. Authoritative — the DOM never decides this. */
	annotationMode: AnnotationMode;
}

export interface Profile {
	id: string;
	name: string;
	/** Backend id; resolved against the registered backends at export time. */
	backendId: string;
	/** Per-profile stylesheet. This is the primary styling surface. */
	stylesheet: string;
	/** CSL style id handed to `zotero-manager`; empty means "its configured default". */
	cslStyle: string;
	page: PageConfig;
	flags: ProfileFlags;
}

/** Vault folder path (no leading/trailing slash, `''` = vault root) -> profile id. */
export type FolderProfileMap = Record<string, string>;

export interface PluginSettings {
	/** Bumped when a shipped default changes in a way old saved settings should follow. */
	settingsVersion: number;
	profiles: Profile[];
	/** Profile used when no folder mapping matches. */
	defaultProfileId: string;
	/** Centralised path-prefix map. Folder metadata lives here, never in the vault. */
	folderProfiles: FolderProfileMap;
	/** Last directory used for bulk export, so the picker can reopen there. */
	lastExportDir: string;
	/** Timeout for a single remote image fetch, in milliseconds. */
	imageFetchTimeoutMs: number;
}

export type BulkExportMode = 'separate' | 'merged';

/** One line of the export report. Severity drives how the shell surfaces it. */
export type ReportSeverity = 'info' | 'warning' | 'error';

export interface ReportEntry {
	severity: ReportSeverity;
	/** Stable machine-readable code, so tests assert on codes and not on prose. */
	code: string;
	message: string;
	/** Vault path or URL the entry concerns, when there is one. */
	subject?: string;
}
