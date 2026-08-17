import { describe, expect, it } from 'vitest';
import { encodeBase64, toDataUri } from '../src/core/base64';
import {
	FAILED_IMAGE_CLASS,
	guessImageMimeType,
	inlineImages,
	isAlreadyInline,
	PLACEHOLDER_IMAGE,
} from '../src/core/image-inline';
import type { FetchedImage, ImageSource } from '../src/core/image-inline';
import { ExportReport } from '../src/core/report';
import { el, root } from './fakes/mock-dom';

/** A fetcher backed by a fixed map. `src/core/` performs no network access of its own. */
class MapImageSource implements ImageSource {
	readonly requests: string[] = [];

	constructor(private readonly entries: Record<string, FetchedImage>) {}

	fetch(src: string): Promise<FetchedImage | null> {
		this.requests.push(src);
		return Promise.resolve(this.entries[src] ?? null);
	}
}

const PIXEL: FetchedImage = { mimeType: 'image/png', bytes: Uint8Array.from([1, 2, 3]) };

describe('encodeBase64', () => {
	it('matches known vectors, including both padding lengths', () => {
		const ascii = (text: string): Uint8Array => Uint8Array.from([...text].map((c) => c.charCodeAt(0)));
		expect(encodeBase64(ascii('man'))).toBe('bWFu');
		expect(encodeBase64(ascii('ma'))).toBe('bWE=');
		expect(encodeBase64(ascii('m'))).toBe('bQ==');
		expect(encodeBase64(new Uint8Array())).toBe('');
	});

	it('handles bytes above 0x7f', () => {
		expect(encodeBase64(Uint8Array.from([0xff, 0xfe, 0xfd]))).toBe('//79');
	});

	it('builds a data URI', () => {
		expect(toDataUri('image/png', Uint8Array.from([0]))).toBe('data:image/png;base64,AA==');
	});
});

describe('guessImageMimeType', () => {
	it('maps common extensions', () => {
		expect(guessImageMimeType('a/b.PNG')).toBe('image/png');
		expect(guessImageMimeType('a/b.jpeg')).toBe('image/jpeg');
		expect(guessImageMimeType('a/b.svg')).toBe('image/svg+xml');
	});

	it('ignores a query string', () => {
		expect(guessImageMimeType('https://x/y.webp?v=2#frag')).toBe('image/webp');
	});

	it('falls back for anything unrecognised', () => {
		expect(guessImageMimeType('https://x/y')).toBe('application/octet-stream');
	});
});

describe('isAlreadyInline', () => {
	it('recognises self-contained sources', () => {
		expect(isAlreadyInline('data:image/png;base64,AA==')).toBe(true);
		expect(isAlreadyInline('blob:abc')).toBe(true);
		expect(isAlreadyInline('https://example.com/a.png')).toBe(false);
	});
});

describe('inlineImages', () => {
	const options = { timeoutMs: 1000 };

	it('replaces fetched images with data URIs', async () => {
		const document = root(el({ tag: 'img', attrs: { src: 'https://x/a.png' } }));
		const source = new MapImageSource({ 'https://x/a.png': PIXEL });
		const result = await inlineImages(document, source, new ExportReport(), options);

		expect(result.inlined).toBe(1);
		expect(result.failed).toBe(0);
		expect(result.substitutions[0]?.dataUri).toBe('data:image/png;base64,AQID');
		expect(result.substitutions[0]?.originalSrc).toBe('https://x/a.png');
	});

	// Decision: an inlining failure is never fatal. A missing image must not cost a
	// 200-page render.
	it('substitutes a layout-preserving placeholder on failure and keeps going', async () => {
		const document = root(
			el({ tag: 'img', attrs: { src: 'https://x/dead.png' } }),
			el({ tag: 'img', attrs: { src: 'https://x/a.png' } }),
		);
		const report = new ExportReport();
		const result = await inlineImages(document, new MapImageSource({ 'https://x/a.png': PIXEL }), report, options);

		expect(result.failed).toBe(1);
		expect(result.inlined).toBe(1);
		expect(result.substitutions[0]).toMatchObject({ failed: true, dataUri: PLACEHOLDER_IMAGE });
		expect(report.has('image-inline-failed')).toBe(true);
		expect(report.errors).toHaveLength(0);
	});

	it('records the failure against the image URL', async () => {
		const document = root(el({ tag: 'img', attrs: { src: 'https://x/dead.png' } }));
		const report = new ExportReport();
		await inlineImages(document, new MapImageSource({}), report, options);
		expect(report.all[0]?.subject).toBe('https://x/dead.png');
	});

	it('skips images that are already inline', async () => {
		const document = root(
			el({ tag: 'img', attrs: { src: 'data:image/png;base64,AA==' } }),
			el({ tag: 'img', attrs: { src: '' } }),
		);
		const source = new MapImageSource({});
		const result = await inlineImages(document, source, new ExportReport(), options);

		expect(result.skipped).toBe(2);
		expect(source.requests).toEqual([]);
	});

	it('fetches a repeated source only once', async () => {
		const document = root(
			el({ tag: 'img', attrs: { src: 'https://x/a.png' } }),
			el({ tag: 'img', attrs: { src: 'https://x/a.png' } }),
		);
		const source = new MapImageSource({ 'https://x/a.png': PIXEL });
		const result = await inlineImages(document, source, new ExportReport(), options);

		expect(source.requests).toEqual(['https://x/a.png']);
		expect(result.substitutions).toHaveLength(2);
	});

	it('caches a failure too, rather than retrying a dead URL per occurrence', async () => {
		const document = root(
			el({ tag: 'img', attrs: { src: 'https://x/dead.png' } }),
			el({ tag: 'img', attrs: { src: 'https://x/dead.png' } }),
		);
		const source = new MapImageSource({});
		await inlineImages(document, source, new ExportReport(), options);
		expect(source.requests).toEqual(['https://x/dead.png']);
	});

	it('reports the failure class name it expects the shell to apply', () => {
		expect(FAILED_IMAGE_CLASS).toBe('mx-image-failed');
	});

	it('does nothing for a document with no images', async () => {
		const result = await inlineImages(root(), new MapImageSource({}), new ExportReport(), options);
		expect(result).toMatchObject({ inlined: 0, failed: 0, skipped: 0, substitutions: [] });
	});
});
