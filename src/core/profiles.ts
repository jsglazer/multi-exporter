import { cssString } from './page-css';
import type { PageConfig, PageFurniture, PageMargins, Profile, ProfileFlags, PluginSettings } from './types';

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
		keepHeadingsWithText: true,
		pageNumbering: 'per-note',
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
/* text-align-last, because a soft line break inside a paragraph is a *forced* break, and the
   line before a forced break is not the block's last line — so justification stretches it to
   the full measure. Obsidian turns every single newline into one of these, which in a
   justified manuscript leaves a trail of six-word lines spaced out like a ransom note. */
body { font-family: "Times New Roman", Times, serif; font-size: 12pt; line-height: 2; text-align: justify; text-align-last: left; }
h1 { break-before: page; string-set: chapter content(text); font-size: 14pt; }
h2 { font-size: 12pt; }
/* Seed the running head from the note's title, so it never prints blank.
   \`chapter\` is set by each h1 below, but plenty of notes start at h2 — # is often reserved
   for the note title, or there is no title heading at all — and a named string that is never
   set makes \`string(chapter)\` empty, which is a silently headerless document. Seeding it
   here means the head reads the note name until the first h1 replaces it, and a document
   with no h1 keeps the note name throughout. The doctitle half repeats the base rule because
   a second string-set on the same element would otherwise override it. */
.mx-doc-title { string-set: doctitle content(text), chapter content(text); }
p { text-indent: 1.5em; margin: 0; }
/* Split deliberately, and it must stay split. paged.js gives *-of-type selectors and sibling
   combinators a rule handler each, and both handlers delete the rule they rewrite — so one
   selector list holding both kinds is removed twice and csstree throws "item doesn't belong to
   list" out of the polisher, before a single page exists. The vendored polyfill is patched to
   survive that, but the two lines cost nothing and do not depend on the patch. */
p:first-of-type { text-indent: 0; }
h1 + p, h2 + p { text-indent: 0; }
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
					// `start`, not the bare form: bare `string()` resolves to the *first* value on
					// the page, so a page where one note ends and the next begins would be headed
					// with the note you have not started reading yet. `start` takes the value in
					// force at the top of the page, falling back to the previous page's — which is
					// what a running head means.
					topLeft: { content: 'string(doctitle, start)' },
					topRight: { content: cssString(DEFAULT_AUTHOR) },
					bottomLeft: { content: 'counter(page) " of " counter(pages)' },
					bottomRight: { content: 'string(docdate, start)' },
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
				// Empty on purpose. `@page :left` / `:right` do not *replace* the general `@page`
				// rule, they cascade with it — a margin box the general rule fills stays filled on
				// every page, recto and verso alike. Putting the page number in `@bottom-center`
				// here as well as in the outer corners below printed it twice on every page, once
				// centred and once in the corner. Anything genuinely common to both sides can go
				// here; anything the recto/verso blocks also set must not.
				furniture: {},
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
 *
 * 2 — the Manuscript stylesheet's first-line-indent rule is split in two. A profile
 * stylesheet is persisted the moment settings are saved, so a vault that has ever opened the
 * settings tab holds its own copy of the crashing selector list and would never pick up the
 * fixed default.
 *
 * 3 — Manuscript's general `@page` furniture is emptied, because it cascaded with the
 * recto/verso blocks rather than being replaced by them and printed the page number twice on
 * every page. Same reasoning as 2: the page config is persisted, so the shipped fix alone
 * reaches nobody who already has the profile.
 */
export const SETTINGS_VERSION = 3;

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

/**
 * The exact rule that crashed paged.js, and the two rules that replace it.
 *
 * `p:first-of-type` is handled by paged.js's `NthOfType`, `h1 + p` by its `Following`, and each
 * handler removes the rule it rewrites — so a selector list holding both is removed twice and
 * csstree throws `item doesn't belong to list` out of the polisher before layout begins.
 */
const LEGACY_INDENT_RULE = 'p:first-of-type, h1 + p, h2 + p { text-indent: 0; }';
const SPLIT_INDENT_RULE = 'p:first-of-type { text-indent: 0; }\nh1 + p, h2 + p { text-indent: 0; }';

/**
 * Split the crashing indent rule in any persisted stylesheet that still carries it verbatim.
 *
 * Matched as an exact line, and only ever replaced with the same declarations expressed as two
 * rules — so nothing about the rendered result changes, and a stylesheet the user has edited
 * around that line is left alone. A user who wrote their own equivalent is covered by the
 * vendored polyfill patch instead; this only rescues the copy the plugin itself handed out.
 */
export function migrateCrashingIndentRule(profiles: readonly Profile[]): Profile[] {
	return profiles.map((profile) =>
		profile.stylesheet.includes(LEGACY_INDENT_RULE)
			? { ...profile, stylesheet: profile.stylesheet.replace(LEGACY_INDENT_RULE, SPLIT_INDENT_RULE) }
			: profile,
	);
}

/**
 * Empty the general furniture on a profile whose recto/verso blocks already set the same box.
 *
 * `@page :left` and `@page :right` cascade *with* the general `@page` rule; they do not
 * replace it. A profile that puts `counter(page)` in `@bottom-center` and again in the outer
 * corner therefore prints two page numbers on every page — which is what the shipped
 * Manuscript profile did.
 *
 * Only a box the recto *or* verso block also fills is cleared, and only when its content is
 * identical to what that block sets. A box the general rule alone owns is genuinely common to
 * both sides and is left exactly where it is.
 */
export function migrateDuplicatedFurniture(profiles: readonly Profile[]): Profile[] {
	return profiles.map((profile) => {
		const { furniture, rectoFurniture, versoFurniture } = profile.page;
		if (rectoFurniture === undefined && versoFurniture === undefined) return profile;

		const sideValues = new Set<string>();
		for (const side of [rectoFurniture, versoFurniture]) {
			for (const [key] of MARGIN_BOX_KEYS) {
				const value = side?.[key]?.content.trim();
				if (value !== undefined && value !== '') sideValues.add(value);
			}
		}
		if (sideValues.size === 0) return profile;

		const kept: PageFurniture = {};
		let dropped = false;
		for (const [key] of MARGIN_BOX_KEYS) {
			const value = furniture[key];
			if (value === undefined) continue;
			if (sideValues.has(value.content.trim())) {
				dropped = true;
				continue;
			}
			kept[key] = value;
		}
		return dropped ? { ...profile, page: { ...profile.page, furniture: kept } } : profile;
	});
}

/** The six margin boxes, as `[key]` tuples — the order is not significant here. */
const MARGIN_BOX_KEYS: [keyof PageFurniture][] = [
	['topLeft'],
	['topCenter'],
	['topRight'],
	['bottomLeft'],
	['bottomCenter'],
	['bottomRight'],
];

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
	const metric = loadedVersion < 1 ? migrateLegacyMetricProfiles(normalized) : normalized;
	const indent = loadedVersion < 2 ? migrateCrashingIndentRule(metric) : metric;
	const profiles = loadedVersion < 3 ? migrateDuplicatedFurniture(indent) : indent;
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
