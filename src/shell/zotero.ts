import type { App } from 'obsidian';
import { getPluginApi, getPluginStringSetting, isPluginEnabled } from '../adapter/obsidian-internals';
import { isWikilinkShapedTemplate } from '../core/citations';
import type { CitationProvider } from '../core/pipeline';

/**
 * The `zotero-manager` gate.
 *
 * An inter-plugin API is a load-order and version dependency, so the rules are strict and
 * the failure mode is deliberately dull: resolve **lazily at export time**, gate on an
 * **exact `version === 1`**, and if anything is missing, disabled or a different version,
 * turn citation features off *for that export*, finish the export, and say so once. This
 * never throws and never blocks a non-citation export.
 */

export const ZOTERO_MANAGER_ID = 'zotero-manager';
export const REQUIRED_API_VERSION = 1;

/** The v1 surface, mirrored from `zotero-manager`'s `src/api.ts`. */
interface ZoteroManagerApiV1 {
	version: number;
	isAvailable(): Promise<boolean>;
	getBibliography(
		keys: string[],
		opts?: { cslStyle?: string; format?: 'html' | 'markdown' },
	): Promise<string | null>;
	getAllCiteKeys(force?: boolean): Promise<{ citekey: string }[]>;
}

function asApiV1(candidate: unknown): ZoteroManagerApiV1 | null {
	if (candidate === null || typeof candidate !== 'object') return null;
	const api = candidate as Partial<ZoteroManagerApiV1>;
	if (api.version !== REQUIRED_API_VERSION) return null;
	if (typeof api.getAllCiteKeys !== 'function' || typeof api.getBibliography !== 'function') return null;
	return api as ZoteroManagerApiV1;
}

/** Why citations are off, when they are. Surfaced once per export. */
export type CitationGateReason = 'ok' | 'not-installed' | 'disabled' | 'wrong-version' | 'unreachable';

export interface CitationGate {
	provider: CitationProvider;
	reason: CitationGateReason;
}

/**
 * Resolve the citation provider for one export.
 *
 * Called at export time, never in `onload` — plugin load order is not something either
 * plugin controls, and caching a reference at load would make citations depend on which
 * plugin Obsidian happened to start first.
 */
export async function resolveCitationGate(app: App, enabled: boolean): Promise<CitationGate> {
	if (!enabled) return { provider: unavailableProvider(), reason: 'ok' };

	if (!isPluginEnabled(app, ZOTERO_MANAGER_ID)) {
		return { provider: unavailableProvider(), reason: 'not-installed' };
	}

	const api = asApiV1(getPluginApi(app, ZOTERO_MANAGER_ID));
	if (api === null) return { provider: unavailableProvider(), reason: 'wrong-version' };

	const reachable = await api.isAvailable().catch(() => false);
	if (!reachable) return { provider: unavailableProvider(), reason: 'unreachable' };

	// The cite-suggest template is user-configurable. It is read for exactly one purpose:
	// to decide whether wikilink detection can work at all. Cite keys are never parsed out
	// of it — `data-href` already carries the key.
	const template = getPluginStringSetting(app, ZOTERO_MANAGER_ID, 'citeSuggestTemplate');
	const wikilinkDetection = isWikilinkShapedTemplate(template);

	return {
		reason: 'ok',
		provider: {
			available: true,
			wikilinkDetection,
			async getAllCiteKeys(): Promise<ReadonlySet<string>> {
				try {
					const entries = await api.getAllCiteKeys();
					return new Set(entries.map((entry) => entry.citekey));
				} catch {
					return new Set<string>();
				}
			},
			async getBibliography(citeKeys: readonly string[], cslStyle: string): Promise<string | null> {
				try {
					const opts = cslStyle === '' ? { format: 'html' as const } : { cslStyle, format: 'html' as const };
					return await api.getBibliography([...citeKeys], opts);
				} catch {
					return null;
				}
			},
		},
	};
}

function unavailableProvider(): CitationProvider {
	return {
		available: false,
		wikilinkDetection: false,
		getAllCiteKeys: (): Promise<ReadonlySet<string>> => Promise.resolve(new Set<string>()),
		getBibliography: (): Promise<string | null> => Promise.resolve(null),
	};
}

export function describeGateReason(reason: CitationGateReason): string {
	switch (reason) {
		case 'not-installed':
			return 'zotero-manager is not installed or not enabled, so citations were skipped.';
		case 'disabled':
			return 'Citation resolution is off for this profile.';
		case 'wrong-version':
			return `zotero-manager did not expose API version ${REQUIRED_API_VERSION}, so citations were skipped.`;
		case 'unreachable':
			return 'Zotero and Better BibTeX were not reachable, so citations were skipped.';
		case 'ok':
			return '';
	}
}
