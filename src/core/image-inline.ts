import { toDataUri } from './base64';
import { toArray } from './dom';
import type { ElementLike, RootLike } from './dom';
import { ExportReport } from './report';

/**
 * Image inlining: every `<img src>` becomes a `data:` URI before pagination, so an export
 * is reproducible and works with the network disconnected.
 *
 * `src/core/` performs no network access. It decides *which* images to inline and *what*
 * each one should become; an injected `ImageSource` does the fetching, and the shell
 * applies the resulting substitutions to the real DOM.
 */

export interface FetchedImage {
	mimeType: string;
	bytes: Uint8Array;
}

/**
 * Fetches an image by URL or vault path. Implemented in the shell over `requestUrl` and the
 * vault adapter; implemented in tests as a fixed map. Returns `null` on any failure — the
 * caller decides what a failure means, and the caller has decided it is never fatal.
 */
export interface ImageSource {
	fetch(src: string, timeoutMs: number): Promise<FetchedImage | null>;
}

/** A 1×1 fully transparent PNG. Preserves the layout box a failed image would have filled. */
export const PLACEHOLDER_IMAGE =
	'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** Class added to any image that could not be fetched, so a stylesheet can mark the gap. */
export const FAILED_IMAGE_CLASS = 'mx-image-failed';

export interface ImageSubstitution {
	element: ElementLike;
	/** Original `src`, kept for the report and for a `data-mx-original-src` attribute. */
	originalSrc: string;
	/** What `src` should become. */
	dataUri: string;
	/** True when the fetch failed and `dataUri` is the placeholder. */
	failed: boolean;
}

export interface InlineImagesResult {
	substitutions: ImageSubstitution[];
	inlined: number;
	failed: number;
	/** Images already inline (`data:`) or otherwise skipped. */
	skipped: number;
}

/** `src` values that are already self-contained and must be left alone. */
export function isAlreadyInline(src: string): boolean {
	return src.startsWith('data:') || src.startsWith('blob:');
}

/**
 * Decide the substitution for every `<img>` under `root`.
 *
 * Serial by construction: a bulk export already runs one note at a time, and hammering a
 * clipped article's origin with 60 parallel requests is a good way to be rate-limited into
 * a page of placeholders.
 *
 * A failure — remote or local — is **non-fatal**. The image becomes a transparent
 * placeholder that keeps its layout box, the failure is recorded in the report, and the
 * export continues. A missing image must not cost you a 200-page render.
 */
export async function inlineImages(
	root: RootLike,
	source: ImageSource,
	report: ExportReport,
	options: { timeoutMs: number },
): Promise<InlineImagesResult> {
	const substitutions: ImageSubstitution[] = [];
	let inlined = 0;
	let failed = 0;
	let skipped = 0;

	const cache = new Map<string, FetchedImage | null>();

	for (const element of toArray(root.querySelectorAll('img'))) {
		const src = element.getAttribute('src');
		if (src === null || src === '' || isAlreadyInline(src)) {
			skipped++;
			continue;
		}

		let fetched = cache.get(src);
		if (fetched === undefined) {
			fetched = await source.fetch(src, options.timeoutMs);
			cache.set(src, fetched);
		}

		if (fetched === null) {
			failed++;
			substitutions.push({ element, originalSrc: src, dataUri: PLACEHOLDER_IMAGE, failed: true });
			report.warn('image-inline-failed', 'Image could not be fetched; a placeholder was substituted.', src);
			continue;
		}

		inlined++;
		substitutions.push({
			element,
			originalSrc: src,
			dataUri: toDataUri(fetched.mimeType, fetched.bytes),
			failed: false,
		});
	}

	return { substitutions, inlined, failed, skipped };
}

/** Guess a MIME type from a URL or path. Used only when the fetch reports none. */
export function guessImageMimeType(src: string): string {
	const withoutQuery = src.split(/[?#]/)[0] ?? src;
	const dot = withoutQuery.lastIndexOf('.');
	const extension = dot === -1 ? '' : withoutQuery.slice(dot + 1).toLowerCase();
	switch (extension) {
		case 'png':
			return 'image/png';
		case 'jpg':
		case 'jpeg':
			return 'image/jpeg';
		case 'gif':
			return 'image/gif';
		case 'webp':
			return 'image/webp';
		case 'avif':
			return 'image/avif';
		case 'bmp':
			return 'image/bmp';
		case 'svg':
			return 'image/svg+xml';
		default:
			return 'application/octet-stream';
	}
}
