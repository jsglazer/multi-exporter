import type { PageConfig, Profile } from './types';

/**
 * The output backend seam.
 *
 * v1 ships exactly one real backend — paged.js pagination plus webview `printToPDF` — plus
 * a test-only fake under `tests/`. The interface exists because the dissertation's required
 * submission format is not yet known, not because a second backend is planned; building a
 * second real one speculatively would be scope the audit did not sanction.
 *
 * Declared in core so the export pipeline can be written against it without core knowing
 * anything about webviews, Electron or PDFs.
 */

export interface PaginateRequest {
	/** Serialised HTML of the rendered document. */
	html: string;
	/** Stylesheet: the profile's CSS plus the generated `@page` rules. */
	css: string;
	page: PageConfig;
}

export interface PaginateResult {
	pageCount: number;
	/** Headings and the page each landed on, ready for `buildOutline`. */
	headings: { level: number; title: string; pageIndex: number }[];
}

export interface RenderedDocument {
	sourcePath: string;
	title: string;
	html: string;
}

export interface ExportRequest {
	documents: readonly RenderedDocument[];
	profile: Profile;
	/** Fully composed stylesheet for this export. */
	css: string;
	/** Called with 0..1 as pagination and printing progress. */
	onProgress?: (fraction: number, label: string) => void;
	/** Polled between stages; a true return aborts the export. */
	isCancelled?: () => boolean;
}

export interface ExportResult {
	/** The finished PDF. */
	pdf: Uint8Array;
	pageCount: number;
	/** Outline source data, already in continuous page order for a merged document. */
	headings: { level: number; title: string; pageIndex: number }[];
	/** For merged exports: the page each document started on, in document order. */
	documentStartPages: number[];
}

export interface ExportBackend {
	readonly id: string;
	/** Human-readable name for the settings dropdown. */
	readonly label: string;
	paginate(request: PaginateRequest): Promise<PaginateResult>;
	export(request: ExportRequest): Promise<ExportResult>;
	/** Release the renderer. Must be safe to call more than once. */
	dispose(): Promise<void>;
}

/** Raised when the user cancels; the shell reports it as an outcome, not a failure. */
export class ExportCancelled extends Error {
	constructor() {
		super('Export cancelled.');
		this.name = 'ExportCancelled';
	}
}
