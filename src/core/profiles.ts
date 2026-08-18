import { cssString } from './page-css';
import type { PageConfig, PageMargins, Profile, ProfileFlags, PluginSettings } from './types';

/**
 * Profiles are data, not code.
 *
 * The three profiles below are **starting examples**, not an enum. Nothing anywhere reads a
 * profile's `name` to decide behaviour — every behavioural difference is a flag — so a
 * profile the user creates is indistinguishable from one that shipped.
 */

export const PAGEDJS_BACKEND_ID = 'pagedjs-webview';

/**
 * Author line in the Article profile's running head.
 *
 * A shipped default like any other value in a profile: it is plain text in
 * `page.furniture.topRight` and is edited or deleted in settings without touching code.
 */
const DEFAULT_AUTHOR = 'Joshua S. Glazer';

/**
 * Imperial by default: US Letter, margins in inches.
 *
 * A margin is any CSS length, so `20mm` remains perfectly valid in a profile — this is the
 * starting point, not a restriction.
 */
function defaultPage(): PageConfig {
	return {
		size: 'Letter',
		orientation: 'portrait',
		margins: { top: '1in', right: '0.75in', bottom: '1in', left: '0.75in' },
		furniture: { bottomCenter: { content: 'counter(page)' } },
		suppressFirstPageFurniture: false,
		orphans: 2,
		widows: 2,
	};
}

function defaultFlags(): ProfileFlags {
	return {
		resolveCitations: false,
		emitBibliography: false,
		inlineImages: true,
		pandocCitationScan: false,
		runSqueezer: false,
		annotationMode: 'off',
	};
}

const ARTICLE_CSS = `/* Clipped articles: prose typography, images kept inside the text block. */
body { font-family: Georgia, "Iowan Old Style", serif; font-size: 11pt; line-height: 1.5; }
h1, h2, h3 { font-family: -apple-system, "Helvetica Neue", sans-serif; line-height: 1.25; }
img { max-width: 100%; height: auto; break-inside: avoid; }
figure, blockquote, pre { break-inside: avoid; }
a { color: inherit; text-decoration: none; }

/* Running head and foot, after LaTeX fancyhdr: note name and author above a 0.4pt rule,
   page-of-total and the export timestamp below one. The margin boxes themselves are named
   in the page settings; what is here is how they look.

   The rules sit on the three text-block boxes and not on the corners, so they span the text
   width exactly as fancyhdr's headrule and footrule do — a border on the whole margin row
   would run into the page edges instead. */
.pagedjs_margin-top-left, .pagedjs_margin-top-center, .pagedjs_margin-top-right {
	align-items: flex-end;
	border-bottom: 0.4pt solid #000;
	padding-bottom: 3pt;
	font-family: -apple-system, "Helvetica Neue", sans-serif;
	font-size: 10pt;
}
.pagedjs_margin-top-left { font-weight: 700; }
.pagedjs_margin-bottom-left, .pagedjs_margin-bottom-center, .pagedjs_margin-bottom-right {
	align-items: flex-start;
	border-top: 0.4pt solid #000;
	padding-top: 3pt;
	font-family: -apple-system, "Helvetica Neue", sans-serif;
	font-size: 8pt;
}
`;

const DATAVIEW_CSS = `/* Dataview / Datacore pages: wide, landscape, tables that survive a page break. */
body { font-family: -apple-system, "Helvetica Neue", sans-serif; font-size: 9pt; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { border: 0.5pt solid #999; padding: 2pt 4pt; text-align: left; vertical-align: top; }
thead { display: table-header-group; }
tr { break-inside: avoid; }
`;

const MANUSCRIPT_CSS = `/* Dissertation chapters: recto/verso furniture, running heads, endnotes. */
body { font-family: "Times New Roman", Times, serif; font-size: 12pt; line-height: 2; text-align: justify; }
h1 { break-before: page; string-set: chapter content(text); font-size: 14pt; }
h2 { font-size: 12pt; }
p { text-indent: 1.5em; margin: 0; }
p:first-of-type, h1 + p, h2 + p { text-indent: 0; }
.mx-bibliography { break-before: page; line-height: 1.5; }
.mx-bibliography > div { text-indent: -2em; padding-left: 2em; margin-bottom: 0.5em; }
.mx-endnotes { break-before: page; line-height: 1.5; }
`;

export function createDefaultProfiles(): Profile[] {
	return [
		{
			id: 'article',
			name: 'Article',
			backendId: PAGEDJS_BACKEND_ID,
			stylesheet: ARTICLE_CSS,
			cslStyle: '',
			page: {
				...defaultPage(),
				// Modelled on the fancyhdr block this profile was asked for: note name and
				// author in the head, "n of m" and the export timestamp in the foot.
				//
				// `string(doctitle)` and `string(docdate)` are set from the zero-height meta
				// block the backend puts at the top of every document, which is the only way
				// a margin box can name the note it belongs to — and the only one that stays
				// right in a merged export, where the answer changes partway down the PDF.
				furniture: {
					topLeft: { content: 'string(doctitle)' },
					topRight: { content: cssString(DEFAULT_AUTHOR) },
					bottomLeft: { content: 'counter(page) " of " counter(pages)' },
					bottomRight: { content: 'string(docdate)' },
				},
			},
			flags: { ...defaultFlags(), inlineImages: true },
		},
		{
			id: 'dataview',
			name: 'Dataview',
			backendId: PAGEDJS_BACKEND_ID,
			stylesheet: DATAVIEW_CSS,
			cslStyle: '',
			page: {
				...defaultPage(),
				orientation: 'landscape',
				margins: { top: '0.5in', right: '0.5in', bottom: '0.6in', left: '0.5in' },
				furniture: {
					bottomLeft: { content: cssString('') },
					bottomRight: { content: 'counter(page) " / " counter(pages)' },
				},
			},
			flags: { ...defaultFlags(), inlineImages: false },
		},
		{
			id: 'manuscript',
			name: 'Manuscript',
			backendId: PAGEDJS_BACKEND_ID,
			stylesheet: MANUSCRIPT_CSS,
			cslStyle: '',
			page: {
				...defaultPage(),
				// A wider left margin is the binding edge, the one place a manuscript wants asymmetry.
				margins: { top: '1in', right: '1in', bottom: '1in', left: '1.25in' },
				furniture: { topCenter: { content: 'string(chapter)' }, bottomCenter: { content: 'counter(page)' } },
				rectoFurniture: { topRight: { content: 'string(chapter)' }, bottomRight: { content: 'counter(page)' } },
				versoFurniture: { topLeft: { content: 'string(chapter)' }, bottomLeft: { content: 'counter(page)' } },
				suppressFirstPageFurniture: true,
			},
			flags: {
				...defaultFlags(),
				resolveCitations: true,
				emitBibliography: true,
				annotationMode: 'endnotes',
			},
		},
	];
}

/**
 * Current settings schema version.
 *
 * 1 — profiles ship imperial (US Letter, margins in inches). Settings saved before this
 * carry the old metric defaults, and persisted settings always beat new defaults, so an
 * existing vault would keep 20mm margins forever without the migration below.
 */
export const SETTINGS_VERSION = 1;

/**
 * The exact metric page defaults that shipped before `SETTINGS_VERSION` 1, each paired with
 * its imperial replacement.
 *
 * Matched as a whole tuple, and only ever when every one of the four margins is untouched.
 * A profile whose margins were edited — even to a value that happens to be metric — does not
 * match, and nothing rewrites it. Migrating a value the user chose would be worse than
 * leaving an old default in place.
 */
const LEGACY_METRIC_PAGES: { legacy: PageMargins; imperial: PageMargins }[] = [
	{
		legacy: { top: '20mm', right: '18mm', bottom: '20mm', left: '18mm' },
		imperial: { top: '1in', right: '0.75in', bottom: '1in', left: '0.75in' },
	},
	{
		legacy: { top: '12mm', right: '12mm', bottom: '14mm', left: '12mm' },
		imperial: { top: '0.5in', right: '0.5in', bottom: '0.6in', left: '0.5in' },
	},
	{
		legacy: { top: '25mm', right: '25mm', bottom: '25mm', left: '32mm' },
		imperial: { top: '1in', right: '1in', bottom: '1in', left: '1.25in' },
	},
];

function sameMargins(a: PageMargins, b: PageMargins): boolean {
	return a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left;
}

/**
 * Rewrite untouched metric defaults to their imperial equivalents, once.
 *
 * The page size moves with them: a profile still carrying the old A4 default alongside old
 * default margins was never configured, so it follows the new Letter default too. A profile
 * whose size was changed keeps it.
 */
export function migrateLegacyMetricProfiles(profiles: readonly Profile[]): Profile[] {
	return profiles.map((profile) => {
		const match = LEGACY_METRIC_PAGES.find((candidate) => sameMargins(profile.page.margins, candidate.legacy));
		if (match === undefined) return profile;
		return {
			...profile,
			page: {
				...profile.page,
				size: profile.page.size === 'A4' ? 'Letter' : profile.page.size,
				margins: { ...match.imperial },
			},
		};
	});
}

export function createDefaultSettings(): PluginSettings {
	const profiles = createDefaultProfiles();
	return {
		settingsVersion: SETTINGS_VERSION,
		profiles,
		defaultProfileId: profiles[0]?.id ?? 'article',
		folderProfiles: {},
		lastExportDir: '',
		imageFetchTimeoutMs: 10000,
	};
}

/** Unique id derived from a name, disambiguated against ids already in use. */
export function makeProfileId(name: string, existing: readonly Profile[]): string {
	const base =
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '') || 'profile';
	const taken = new Set(existing.map((profile) => profile.id));
	if (!taken.has(base)) return base;
	for (let counter = 2; ; counter++) {
		const candidate = `${base}-${counter}`;
		if (!taken.has(candidate)) return candidate;
	}
}

/** Deep copy of a profile under a new name and id. Used by "Duplicate" in settings. */
export function duplicateProfile(profile: Profile, existing: readonly Profile[]): Profile {
	const name = `${profile.name} copy`;
	return {
		...structuredCloneProfile(profile),
		id: makeProfileId(name, existing),
		name,
	};
}

/**
 * Copy without `structuredClone`, which is a host global rather than a language feature and
 * would tie core to a runtime that provides it.
 */
export function structuredCloneProfile(profile: Profile): Profile {
	return {
		...profile,
		page: {
			...profile.page,
			margins: { ...profile.page.margins },
			furniture: { ...profile.page.furniture },
			...(profile.page.rectoFurniture === undefined ? {} : { rectoFurniture: { ...profile.page.rectoFurniture } }),
			...(profile.page.versoFurniture === undefined ? {} : { versoFurniture: { ...profile.page.versoFurniture } }),
		},
		flags: { ...profile.flags },
	};
}

/**
 * Fill in anything missing from a persisted settings object.
 *
 * `data.json` is user-editable and survives across versions, so every field is treated as
 * possibly absent or of the wrong type rather than trusted.
 */
export function normalizeSettings(loaded: unknown): PluginSettings {
	const defaults = createDefaultSettings();
	if (loaded === null || typeof loaded !== 'object') return defaults;
	const raw = loaded as Partial<PluginSettings>;

	const loadedVersion = typeof raw.settingsVersion === 'number' ? raw.settingsVersion : 0;
	const normalized =
		Array.isArray(raw.profiles) && raw.profiles.length > 0 ? raw.profiles.map(normalizeProfile) : defaults.profiles;
	const profiles = loadedVersion < 1 ? migrateLegacyMetricProfiles(normalized) : normalized;
	const ids = new Set(profiles.map((profile) => profile.id));
	const defaultProfileId =
		typeof raw.defaultProfileId === 'string' && ids.has(raw.defaultProfileId)
			? raw.defaultProfileId
			: (profiles[0]?.id ?? defaults.defaultProfileId);

	const folderProfiles: Record<string, string> = {};
	if (raw.folderProfiles !== null && typeof raw.folderProfiles === 'object') {
		for (const [folder, profileId] of Object.entries(raw.folderProfiles as Record<string, unknown>)) {
			if (typeof profileId === 'string') folderProfiles[folder] = profileId;
		}
	}

	return {
		settingsVersion: SETTINGS_VERSION,
		profiles,
		defaultProfileId,
		folderProfiles,
		lastExportDir: typeof raw.lastExportDir === 'string' ? raw.lastExportDir : '',
		imageFetchTimeoutMs:
			typeof raw.imageFetchTimeoutMs === 'number' && raw.imageFetchTimeoutMs > 0
				? raw.imageFetchTimeoutMs
				: defaults.imageFetchTimeoutMs,
	};
}

function normalizeProfile(raw: unknown): Profile {
	const template = createDefaultProfiles()[0];
	if (template === undefined) throw new Error('No default profile template.');
	if (raw === null || typeof raw !== 'object') return template;
	const partial = raw as Partial<Profile>;

	return {
		id: typeof partial.id === 'string' && partial.id !== '' ? partial.id : template.id,
		name: typeof partial.name === 'string' && partial.name !== '' ? partial.name : template.name,
		backendId: typeof partial.backendId === 'string' && partial.backendId !== '' ? partial.backendId : PAGEDJS_BACKEND_ID,
		stylesheet: typeof partial.stylesheet === 'string' ? partial.stylesheet : template.stylesheet,
		cslStyle: typeof partial.cslStyle === 'string' ? partial.cslStyle : '',
		page: { ...template.page, ...(partial.page ?? {}) },
		flags: { ...template.flags, ...(partial.flags ?? {}) },
	};
}
