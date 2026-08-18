import { describe, expect, it } from 'vitest';
import {
	createDefaultProfiles,
	createDefaultSettings,
	migrateCrashingIndentRule,
	migrateDuplicatedFurniture,
	migrateLegacyMetricProfiles,
	normalizeSettings,
	SETTINGS_VERSION,
} from '../src/core/profiles';
import type { PageMargins, Profile } from '../src/core/types';

/**
 * Persisted settings beat new defaults — that is the whole point of `data.json`, and it is
 * why changing a shipped default is not enough on its own. The migration below is the one
 * sanctioned exception: an *untouched* old default follows the new one, and nothing else
 * is ever rewritten.
 */

const LEGACY_ARTICLE: PageMargins = { top: '20mm', right: '18mm', bottom: '20mm', left: '18mm' };

function savedProfile(overrides: { margins?: PageMargins; size?: Profile['page']['size'] } = {}): Profile {
	const template = createDefaultProfiles()[0] as Profile;
	return {
		...template,
		page: {
			...template.page,
			size: overrides.size ?? 'A4',
			margins: overrides.margins ?? { ...LEGACY_ARTICLE },
		},
	};
}

describe('imperial defaults', () => {
	it('ships US Letter with margins in inches', () => {
		for (const profile of createDefaultProfiles()) {
			expect(profile.page.size).toBe('Letter');
			for (const edge of Object.values(profile.page.margins)) expect(edge).toMatch(/in$/);
		}
	});

	it('stamps the current schema version on fresh settings', () => {
		expect(createDefaultSettings().settingsVersion).toBe(SETTINGS_VERSION);
	});
});

describe('migrateLegacyMetricProfiles', () => {
	it('rewrites an untouched metric default, page size included', () => {
		const [migrated] = migrateLegacyMetricProfiles([savedProfile()]);
		expect(migrated?.page.margins).toEqual({ top: '1in', right: '0.75in', bottom: '1in', left: '0.75in' });
		expect(migrated?.page.size).toBe('Letter');
	});

	it('leaves margins the user chose alone, metric or not', () => {
		const chosen: PageMargins = { top: '30mm', right: '18mm', bottom: '20mm', left: '18mm' };
		const [migrated] = migrateLegacyMetricProfiles([savedProfile({ margins: chosen })]);
		expect(migrated?.page.margins).toEqual(chosen);
		expect(migrated?.page.size).toBe('A4');
	});

	it('keeps a page size the user chose, even when the margins are an untouched default', () => {
		const [migrated] = migrateLegacyMetricProfiles([savedProfile({ size: 'Legal' })]);
		expect(migrated?.page.size).toBe('Legal');
		expect(migrated?.page.margins.top).toBe('1in');
	});
});

describe('normalizeSettings', () => {
	it('migrates settings saved before the schema was versioned', () => {
		const settings = normalizeSettings({ profiles: [savedProfile()], defaultProfileId: 'article' });
		expect(settings.profiles[0]?.page.margins.top).toBe('1in');
		expect(settings.settingsVersion).toBe(SETTINGS_VERSION);
	});

	it('does not touch profiles once the settings carry the current version', () => {
		const settings = normalizeSettings({
			settingsVersion: SETTINGS_VERSION,
			profiles: [savedProfile()],
			defaultProfileId: 'article',
		});
		expect(settings.profiles[0]?.page.margins).toEqual(LEGACY_ARTICLE);
		expect(settings.profiles[0]?.page.size).toBe('A4');
	});
});

/**
 * A page field added after a vault has already saved its profiles.
 *
 * `normalizeProfile` spreads the template's page *under* the saved one, so a field that did
 * not exist when the settings were written picks up the shipped default rather than
 * `undefined` — no migration, no settings-version bump. This is what makes
 * `keepHeadingsWithText` reach existing vaults switched on, and it guards the pattern for
 * whatever page field comes next.
 */
describe('a page field the saved settings predate', () => {
	it('takes the shipped default rather than undefined', () => {
		const saved = {
			settingsVersion: SETTINGS_VERSION,
			profiles: [
				{
					id: 'article',
					name: 'Article',
					backendId: 'pagedjs-webview',
					stylesheet: '',
					cslStyle: '',
					// Exactly what an older `data.json` holds: no `keepHeadingsWithText`.
					page: {
						size: 'Letter',
						orientation: 'portrait',
						margins: { top: '1in', right: '0.75in', bottom: '1in', left: '0.75in' },
						furniture: {},
						suppressFirstPageFurniture: false,
						orphans: 2,
						widows: 2,
					},
					flags: {},
				},
			],
		};

		const settings = normalizeSettings(saved);
		expect(settings.profiles[0]?.page.keepHeadingsWithText).toBe(true);
		expect(settings.profiles[0]?.page.pageNumbering).toBe('per-note');
	});

	it('leaves an explicit false alone', () => {
		const settings = normalizeSettings({
			settingsVersion: SETTINGS_VERSION,
			profiles: [{ ...createDefaultProfiles()[0], page: { ...createDefaultProfiles()[0]?.page, keepHeadingsWithText: false } }],
		});
		expect(settings.profiles[0]?.page.keepHeadingsWithText).toBe(false);
	});
});

/**
 * A selector list holding both a `*-of-type` pseudo and a `+` combinator is removed twice by
 * paged.js — once by its `NthOfType` rule handler, once by its `Following` one — and csstree
 * throws `item doesn't belong to list` out of the polisher before layout begins. The
 * Manuscript profile shipped exactly such a rule, and a profile stylesheet is persisted the
 * moment settings are saved, so fixing the shipped default rescues new vaults only.
 */
describe('migrateCrashingIndentRule', () => {
	const CRASHING = 'p:first-of-type, h1 + p, h2 + p { text-indent: 0; }';

	function saved(stylesheet: string): Profile {
		return { ...(createDefaultProfiles()[0] as Profile), stylesheet };
	}

	it('splits the rule the plugin itself handed out', () => {
		const [migrated] = migrateCrashingIndentRule([saved(`p { text-indent: 1.5em; }\n${CRASHING}\nh2 { font-size: 12pt; }`)]);
		expect(migrated?.stylesheet).not.toContain(CRASHING);
		expect(migrated?.stylesheet).toContain('p:first-of-type { text-indent: 0; }');
		expect(migrated?.stylesheet).toContain('h1 + p, h2 + p { text-indent: 0; }');
	});

	it('keeps every other line of the stylesheet untouched', () => {
		const [migrated] = migrateCrashingIndentRule([saved(`h1 { break-before: page; }\n${CRASHING}`)]);
		expect(migrated?.stylesheet.startsWith('h1 { break-before: page; }\n')).toBe(true);
	});

	it('leaves a stylesheet that never carried the rule alone', () => {
		const original = saved('body { font-size: 11pt; }');
		expect(migrateCrashingIndentRule([original])[0]).toBe(original);
	});

	it('does not touch a rule the user rewrote, even into something equivalent', () => {
		const edited = saved('p:first-of-type, h1 + p { text-indent: 0; }');
		expect(migrateCrashingIndentRule([edited])[0]?.stylesheet).toBe('p:first-of-type, h1 + p { text-indent: 0; }');
	});

	it('runs on load for settings saved before schema version 2', () => {
		const settings = normalizeSettings({ settingsVersion: 1, profiles: [saved(CRASHING)] });
		expect(settings.profiles[0]?.stylesheet).not.toContain(CRASHING);
		expect(settings.settingsVersion).toBe(SETTINGS_VERSION);
	});

	it('is not re-run on settings already at the current version', () => {
		const settings = normalizeSettings({ settingsVersion: SETTINGS_VERSION, profiles: [saved(CRASHING)] });
		expect(settings.profiles[0]?.stylesheet).toBe(CRASHING);
	});
});

/** The shipped stylesheets must not reintroduce the crash the migration exists to undo. */
describe('shipped profile stylesheets', () => {
	it('never put a *-of-type pseudo and a + combinator in one selector list', () => {
		for (const profile of createDefaultProfiles()) {
			for (const rule of profile.stylesheet.split('}')) {
				const selector = rule.split('{')[0] ?? '';
				if (!selector.includes(',')) continue;
				const bothKinds = /:(?:first|last|nth)-of-type/.test(selector) && selector.includes('+');
				expect(bothKinds, `${profile.name}: ${selector.trim()}`).toBe(false);
			}
		}
	});
});

/**
 * `@page :left` and `@page :right` cascade *with* the general `@page` rule rather than
 * replacing it, so a margin box the general rule fills stays filled on both sides. The
 * shipped Manuscript profile put `counter(page)` in `@bottom-center` and again in each outer
 * corner, and every page came out of the exporter carrying two page numbers.
 */
describe('migrateDuplicatedFurniture', () => {
	function saved(page: Partial<Profile['page']>): Profile {
		const template = createDefaultProfiles()[0] as Profile;
		return { ...template, page: { ...template.page, ...page } as Profile['page'] };
	}

	const shippedManuscriptPage = {
		furniture: { topCenter: { content: 'string(chapter)' }, bottomCenter: { content: 'counter(page)' } },
		rectoFurniture: { topRight: { content: 'string(chapter)' }, bottomRight: { content: 'counter(page)' } },
		versoFurniture: { topLeft: { content: 'string(chapter)' }, bottomLeft: { content: 'counter(page)' } },
	};

	it('empties a general box the recto/verso blocks already set', () => {
		const [migrated] = migrateDuplicatedFurniture([saved(shippedManuscriptPage)]);
		expect(migrated?.page.furniture).toEqual({});
		// The side blocks are the ones that place the furniture; they must survive intact.
		expect(migrated?.page.rectoFurniture).toEqual(shippedManuscriptPage.rectoFurniture);
		expect(migrated?.page.versoFurniture).toEqual(shippedManuscriptPage.versoFurniture);
	});

	it('keeps a general box neither side duplicates — that one is genuinely common', () => {
		const [migrated] = migrateDuplicatedFurniture([
			saved({
				...shippedManuscriptPage,
				furniture: {
					bottomCenter: { content: 'counter(page)' },
					topLeft: { content: '"Draft — do not circulate"' },
				},
			}),
		]);
		expect(migrated?.page.furniture).toEqual({ topLeft: { content: '"Draft — do not circulate"' } });
	});

	it('leaves a profile with no recto/verso furniture untouched', () => {
		const original = saved({ furniture: { bottomCenter: { content: 'counter(page)' } } });
		expect(migrateDuplicatedFurniture([original])[0]).toBe(original);
	});

	it('leaves a profile whose sides set different content untouched', () => {
		const original = saved({
			furniture: { bottomCenter: { content: 'counter(page)' } },
			rectoFurniture: { topRight: { content: 'string(chapter)' } },
		});
		expect(migrateDuplicatedFurniture([original])[0]).toBe(original);
	});

	it('runs on load for settings saved before schema version 3', () => {
		const settings = normalizeSettings({ settingsVersion: 2, profiles: [saved(shippedManuscriptPage)] });
		expect(settings.profiles[0]?.page.furniture).toEqual({});
		expect(settings.settingsVersion).toBe(SETTINGS_VERSION);
	});

	it('is not re-run on settings already at the current version', () => {
		const settings = normalizeSettings({ settingsVersion: SETTINGS_VERSION, profiles: [saved(shippedManuscriptPage)] });
		expect(settings.profiles[0]?.page.furniture).toEqual(shippedManuscriptPage.furniture);
	});
});

describe('the shipped Manuscript profile', () => {
	const manuscript = createDefaultProfiles().find((profile) => profile.id === 'manuscript') as Profile;

	it('never places the same content in a general box and a recto/verso box', () => {
		const sides = [manuscript.page.rectoFurniture, manuscript.page.versoFurniture];
		const sideContent = new Set(
			sides.flatMap((side) => Object.values(side ?? {}).map((box) => box.content.trim())),
		);
		for (const [box, value] of Object.entries(manuscript.page.furniture)) {
			expect(sideContent.has(value.content.trim()), `@${box} is duplicated by a recto/verso block`).toBe(false);
		}
	});

	it('pins the last line of a justified block, so a soft line break is not stretched', () => {
		expect(manuscript.stylesheet).toContain('text-align: justify; text-align-last: left;');
	});

	it('seeds the running-head string from the note title, so an h2-only note is not headerless', () => {
		expect(manuscript.stylesheet).toContain('.mx-doc-title { string-set: doctitle content(text), chapter content(text); }');
	});
});
