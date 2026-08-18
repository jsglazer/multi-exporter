/**
 * Data shapes shared across the pure core.
 *
 * A profile is *data, not code*: nothing here or anywhere else branches on a profile's
 * name. Every behavioural difference reads a flag off the profile record, so a
 * user-created profile is indistinguishable from a shipped one.
 */

export type AnnotationMode = 'gutter' | 'endnotes' | 'off';

export type PageSize = 'Letter' | 'Legal' | 'Tabloid' | 'A4' | 'A5';

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
