import { describe, expect, it } from 'vitest';
import {
	createDefaultProfiles,
	createDefaultSettings,
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
