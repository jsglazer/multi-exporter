import type { App } from 'obsidian';
import { getMdAnnotationCategoryColors, getPluginApi, isPluginEnabled } from '../adapter/obsidian-internals';
import type { AnnotationRecord } from '../core/annotations';
import type { AnnotationProvider } from '../core/pipeline';

/**
 * The `md-annotation` gate.
 *
 * The same shape and the same rules as the `zotero-manager` gate next door, for the same
 * reason: an inter-plugin API is a load-order and version dependency, so it is resolved
 * **lazily at export time** — never in `onload` — and anything missing, disabled or
 * unrecognisable turns annotations off *for that export*, finishes the export, and says so
 * once. This never throws and never blocks an export.
 *
 * What it reads is `getAnnotations(path)`, which re-parses the note's `%%md-annotation`
 * block from disk. That is what makes it usable at all here: it does not need a view to be
 * open, and a headless export has none.
 */

export const MD_ANNOTATION_ID = 'md-annotation';

/** The slice of `md-annotation`'s API an export uses, mirrored from its `src/api.ts`. */
interface MdAnnotationApi {
	getAnnotations(path: string): Promise<unknown[]>;
}

function asApi(candidate: unknown): MdAnnotationApi | null {
	if (candidate === null || typeof candidate !== 'object') return null;
	const api = candidate as Partial<MdAnnotationApi>;
	return typeof api.getAnnotations === 'function' ? (api as MdAnnotationApi) : null;
}

/** Why annotations are off, when they are. Surfaced once per export. */
export type AnnotationGateReason = 'ok' | 'not-installed' | 'disabled' | 'wrong-shape';

export interface AnnotationGate {
	provider: AnnotationProvider;
	reason: AnnotationGateReason;
}

/**
 * Resolve the annotation provider for one export.
 *
 * `enabled` is the profile's own decision — `annotationMode !== 'off'` — and a profile with
 * annotations switched off never touches the other plugin at all.
 */
export function resolveAnnotationGate(app: App, enabled: boolean): AnnotationGate {
	if (!enabled) return { provider: unavailableProvider(), reason: 'ok' };

	if (!isPluginEnabled(app, MD_ANNOTATION_ID)) {
		return { provider: unavailableProvider(), reason: 'not-installed' };
	}

	const api = asApi(getPluginApi(app, MD_ANNOTATION_ID));
	if (api === null) return { provider: unavailableProvider(), reason: 'wrong-shape' };

	// Read once per export, not once per note: it is a settings object, and a bulk export
	// would otherwise walk the plugin registry for every file.
	const categoryColors = getMdAnnotationCategoryColors(app, MD_ANNOTATION_ID);

	return {
		reason: 'ok',
		provider: {
			available: true,
			categoryColors,
			async getAnnotations(sourcePath: string): Promise<AnnotationRecord[]> {
				try {
					const raw = await api.getAnnotations(sourcePath);
					return Array.isArray(raw) ? raw.map(toRecord).filter(isRecord) : [];
				} catch {
					// A note the other plugin could not parse is not a reason to fail an export.
					return [];
				}
			},
		},
	};
}

/**
 * One API object into an `AnnotationRecord`, or `null` if it is not one.
 *
 * `category` is the v1.0.20 spelling and `format` the one before it. The API emits both on
 * every record, but reading either means a vault still running the older plugin keeps
 * working, and the field is what colours the highlight — falling back to `''` silently
 * would print every category the same.
 */
function toRecord(value: unknown): AnnotationRecord | null {
	if (value === null || typeof value !== 'object') return null;
	const raw = value as Record<string, unknown>;
	if (typeof raw['id'] !== 'string') return null;
	if (raw['type'] !== 'highlight' && raw['type'] !== 'comment') return null;

	const selector = raw['selector'];
	if (selector === null || typeof selector !== 'object') return null;
	const parts = selector as Record<string, unknown>;
	if (typeof parts['exact'] !== 'string' || typeof parts['prefix'] !== 'string' || typeof parts['suffix'] !== 'string') {
		return null;
	}

	const category = raw['category'] ?? raw['format'];
	return {
		id: raw['id'],
		type: raw['type'],
		category: typeof category === 'string' ? category : '',
		selector: { exact: parts['exact'], prefix: parts['prefix'], suffix: parts['suffix'] },
		comment: typeof raw['comment'] === 'string' ? raw['comment'] : '',
		author: typeof raw['author'] === 'string' ? raw['author'] : '',
		status: raw['status'] === 'closed' ? 'closed' : 'open',
	};
}

function isRecord(value: AnnotationRecord | null): value is AnnotationRecord {
	return value !== null;
}

function unavailableProvider(): AnnotationProvider {
	return {
		available: false,
		categoryColors: {},
		getAnnotations: (): Promise<AnnotationRecord[]> => Promise.resolve([]),
	};
}

export function describeAnnotationGateReason(reason: AnnotationGateReason): string {
	switch (reason) {
		case 'not-installed':
			return 'md-annotation is not installed or not enabled, so annotations were skipped.';
		case 'disabled':
			return 'Annotations are off for this profile.';
		case 'wrong-shape':
			return 'md-annotation did not expose a getAnnotations API, so annotations were skipped.';
		case 'ok':
			return '';
	}
}
