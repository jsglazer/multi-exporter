import { FileSystemAdapter, requestUrl } from 'obsidian';
import type { App, TFile } from 'obsidian';
import { guessImageMimeType } from '../core/image-inline';
import type { FetchedImage, ImageSource } from '../core/image-inline';

/**
 * Fetching image bytes — the only network access in the plugin, and the only reason
 * `src/core/` needs an injectable fetcher rather than doing this itself.
 *
 * Both halves are non-fatal by construction: every failure path returns `null`, and the
 * caller substitutes a placeholder that preserves the layout box. A clipped article with
 * one dead image link must still export.
 */
export class ObsidianImageSource implements ImageSource {
	constructor(private readonly app: App) {}

	async fetch(src: string, timeoutMs: number): Promise<FetchedImage | null> {
		try {
			return src.startsWith('http://') || src.startsWith('https://')
				? await this.fetchRemote(src, timeoutMs)
				: await this.fetchLocal(src);
		} catch {
			return null;
		}
	}

	/**
	 * `requestUrl` rather than `fetch`: it goes through Obsidian's own request path and is
	 * not subject to the renderer's CORS policy, which would block most article images.
	 * It has no timeout of its own, so one is raced against it.
	 */
	private async fetchRemote(url: string, timeoutMs: number): Promise<FetchedImage | null> {
		const request = requestUrl({ url, method: 'GET', throw: false });
		const response = await withTimeout(request, timeoutMs);
		if (response === null || response.status < 200 || response.status >= 300) return null;

		const contentType = response.headers['content-type'] ?? response.headers['Content-Type'];
		const mimeType =
			typeof contentType === 'string' && contentType.startsWith('image/')
				? (contentType.split(';')[0] ?? guessImageMimeType(url))
				: guessImageMimeType(url);
		return { mimeType, bytes: new Uint8Array(response.arrayBuffer) };
	}

	/**
	 * A vault image. Obsidian rewrites embedded images to `app://` URLs carrying the real
	 * path, so the path is recovered and read through the vault adapter rather than through
	 * `fs` — which keeps this working regardless of where the vault lives.
	 */
	private async fetchLocal(src: string): Promise<FetchedImage | null> {
		const file = this.resolveFile(src);
		if (file === null) return null;

		const bytes = new Uint8Array(await this.app.vault.readBinary(file));
		return { mimeType: guessImageMimeType(file.path), bytes };
	}

	/**
	 * Find the vault file a rendered `src` refers to.
	 *
	 * The path inside an `app://` URL is **OS-absolute**, not vault-relative, so handing it
	 * straight to `getFileByPath` never matched: every vault image failed silently and was
	 * replaced by the transparent placeholder — in the PDF as well as the preview, which is
	 * a picture that is simply missing rather than an error anyone would notice. Three
	 * attempts, cheapest first: the path as given, the path with the vault's own base
	 * directory removed, then the file name resolved the way a link would resolve it.
	 */
	private resolveFile(src: string): TFile | null {
		const path = toVaultPath(src);
		if (path === null) return null;

		const direct = this.app.vault.getFileByPath(path);
		if (direct !== null) return direct;

		const base = this.vaultBasePath();
		const absolute = path.startsWith('/') ? path : `/${path}`;
		if (base !== null && absolute.startsWith(`${base}/`)) {
			const relative = this.app.vault.getFileByPath(absolute.slice(base.length + 1));
			if (relative !== null) return relative;
		}

		const name = absolute.slice(absolute.lastIndexOf('/') + 1);
		return name === '' ? null : this.app.metadataCache.getFirstLinkpathDest(name, '');
	}

	/** The vault's directory on disk, or `null` when the vault is not on a filesystem. */
	private vaultBasePath(): string | null {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) return null;
		const base = adapter.getBasePath();
		return base.endsWith('/') ? base.slice(0, -1) : base;
	}
}

/**
 * Recover a vault-relative path from the `src` Obsidian put on a rendered image.
 *
 * Rendered embeds carry `app://<hash>/<absolute path>?<mtime>` on desktop. The query string
 * and the resource-host prefix are stripped, and the result is only usable if it still
 * looks like a vault path — anything else returns `null` and becomes a placeholder.
 */
export function toVaultPath(src: string): string | null {
	const withoutQuery = src.split('?')[0] ?? src;
	const decoded = safeDecode(withoutQuery);

	if (decoded.startsWith('app://')) {
		const afterScheme = decoded.slice('app://'.length);
		const slash = afterScheme.indexOf('/');
		if (slash === -1) return null;
		return afterScheme.slice(slash + 1);
	}
	if (decoded.startsWith('file://')) return decoded.slice('file://'.length);
	if (decoded.startsWith('data:') || decoded.startsWith('blob:')) return null;
	return decoded;
}

function safeDecode(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
	return new Promise<T | null>((resolve) => {
		const timer = window.setTimeout(() => resolve(null), timeoutMs);
		promise.then(
			(value) => {
				window.clearTimeout(timer);
				resolve(value);
			},
			() => {
				window.clearTimeout(timer);
				resolve(null);
			},
		);
	});
}
