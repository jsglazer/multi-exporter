import { describe, expect, it } from 'vitest';
import {
	ensurePdfExtension,
	isExportableNote,
	orderNotes,
	planMergedExport,
	planSeparateExport,
	singleNoteDestination,
} from '../src/core/export-plan';
import { comparePathsHierarchyFirst, sanitizeFileName } from '../src/core/paths';
import { createDefaultProfiles } from '../src/core/profiles';
import type { Profile } from '../src/core/types';

const profiles = createDefaultProfiles();
const article = profiles.find((profile) => profile.id === 'article') as Profile;
const manuscript = profiles.find((profile) => profile.id === 'manuscript') as Profile;
const dataview = profiles.find((profile) => profile.id === 'dataview') as Profile;

describe('isExportableNote', () => {
	it('accepts markdown only', () => {
		expect(isExportableNote('a/b.md')).toBe(true);
		expect(isExportableNote('a/b.MD')).toBe(true);
		expect(isExportableNote('a/b.pdf')).toBe(false);
		expect(isExportableNote('a/b.canvas')).toBe(false);
		expect(isExportableNote('a/b')).toBe(false);
	});
});

describe('ordering', () => {
	// "Alphabetical by folder hierarchy first, then file name": files directly in a folder
	// come before files in its subfolders, and only files sharing a folder are compared by
	// name.
	it('orders by folder hierarchy first, then file name', () => {
		expect(
			orderNotes([
				'A/B/deep.md',
				'A/zebra.md',
				'A/apple.md',
				'B/first.md',
				'A/B/another.md',
				'root.md',
			]),
		).toEqual(['root.md', 'A/apple.md', 'A/zebra.md', 'A/B/another.md', 'A/B/deep.md', 'B/first.md']);
	});

	it('filters out anything that is not markdown', () => {
		expect(orderNotes(['a.md', 'b.png', 'c.canvas'])).toEqual(['a.md']);
	});

	/**
	 * Case must not outrank the alphabet.
	 *
	 * A raw code-point comparison puts every capital ahead of every lowercase letter, which put
	 * `GRE combination…` before `Goal Statement…` in a real export — `R` (0x52) beating `o`
	 * (0x6F). Nobody reading the folder calls that alphabetical, and it does not match the order
	 * Obsidian's own file explorer shows.
	 */
	it('orders case-insensitively', () => {
		expect(comparePathsHierarchyFirst('A/apple.md', 'A/Zebra.md')).toBeLessThan(0);
		// The exact pair from the report.
		expect(
			orderNotes(['A/GRE combination and permutations problems.md', 'A/Goal Statement.md']),
		).toEqual(['A/Goal Statement.md', 'A/GRE combination and permutations problems.md']);
	});

	it('orders folder segments case-insensitively too', () => {
		expect(comparePathsHierarchyFirst('apple/x.md', 'Zebra/x.md')).toBeLessThan(0);
	});

	// A locale-aware collator would make the export order depend on the machine running it.
	// `toLowerCase()` without a locale uses Unicode's default case mapping, so this stays
	// deterministic — and names differing only in case still get a stable order rather than an
	// arbitrary one.
	it('breaks case-only ties deterministically', () => {
		expect(comparePathsHierarchyFirst('A/README.md', 'A/readme.md')).toBeLessThan(0);
		expect(comparePathsHierarchyFirst('A/readme.md', 'A/README.md')).toBeGreaterThan(0);
	});

	it('is stable for identical paths', () => {
		expect(comparePathsHierarchyFirst('A/x.md', 'A/x.md')).toBe(0);
	});
});

describe('sanitizeFileName', () => {
	it('replaces characters that are unsafe in a path segment', () => {
		expect(sanitizeFileName('Q3: profit/loss?')).toBe('Q3- profit-loss-');
	});

	it('never returns an empty name', () => {
		expect(sanitizeFileName('...')).toBe('untitled');
		expect(sanitizeFileName('   ')).toBe('untitled');
	});

	it('leaves an ordinary title alone', () => {
		expect(sanitizeFileName('Chapter 2 — Method')).toBe('Chapter 2 — Method');
	});
});

describe('planSeparateExport', () => {
	const base = {
		sourceRoot: 'Research',
		outputDir: '/out',
		profiles,
		folderProfiles: { Research: 'manuscript', 'Research/Data': 'dataview' },
		defaultProfileId: 'article',
		overrideProfile: null,
	};

	it('reproduces the source hierarchy under the output directory', () => {
		const plan = planSeparateExport({
			...base,
			paths: ['Research/intro.md', 'Research/Data/table.md', 'Research/Data/Raw/dump.md'],
		});
		expect(plan.notes.map((note) => note.destination)).toEqual([
			'/out/intro.pdf',
			'/out/Data/table.pdf',
			'/out/Data/Raw/dump.pdf',
		]);
	});

	it('resolves each note against its own folder default', () => {
		const plan = planSeparateExport({ ...base, paths: ['Research/intro.md', 'Research/Data/table.md'] });
		expect(plan.notes.map((note) => note.profile.id)).toEqual(['manuscript', 'dataview']);
	});

	it('applies the modal override to every note when one is given', () => {
		const plan = planSeparateExport({
			...base,
			paths: ['Research/intro.md', 'Research/Data/table.md'],
			overrideProfile: article,
		});
		expect(plan.notes.map((note) => note.profile.id)).toEqual(['article', 'article']);
	});

	it('sanitises every path segment it generates', () => {
		const plan = planSeparateExport({
			...base,
			paths: ['Research/Q1: draft.md'],
		});
		expect(plan.notes[0]?.destination).toBe('/out/Q1- draft.pdf');
	});

	it('carries the note title through for the outline', () => {
		const plan = planSeparateExport({ ...base, paths: ['Research/intro.md'] });
		expect(plan.notes[0]?.title).toBe('intro');
	});

	it('has no merged destination or merged profile', () => {
		const plan = planSeparateExport({ ...base, paths: ['Research/intro.md'] });
		expect(plan.mode).toBe('separate');
		expect(plan.mergedDestination).toBeNull();
		expect(plan.mergedProfile).toBeNull();
	});

	it('plans nothing for an empty selection', () => {
		expect(planSeparateExport({ ...base, paths: [] }).notes).toEqual([]);
	});
});

describe('planMergedExport', () => {
	// Decision: merged export uses exactly one profile for the entire document. Per-folder
	// defaults are a separate-mode and single-note concept — continuous page numbering
	// across per-note page geometry means nothing.
	it('applies one profile to every note regardless of folder defaults', () => {
		const plan = planMergedExport({
			paths: ['Research/intro.md', 'Research/Data/table.md'],
			outputFile: '/out/Thesis.pdf',
			profile: manuscript,
		});
		expect(plan.notes.every((note) => note.profile.id === 'manuscript')).toBe(true);
		expect(plan.mergedProfile?.id).toBe('manuscript');
	});

	it('keeps the hierarchy-first order', () => {
		const plan = planMergedExport({
			paths: ['B/one.md', 'A/two.md', 'A/B/three.md'],
			outputFile: '/out/All.pdf',
			profile: dataview,
		});
		expect(plan.notes.map((note) => note.sourcePath)).toEqual(['A/two.md', 'A/B/three.md', 'B/one.md']);
	});

	it('gives every note a null destination — there is only one output file', () => {
		const plan = planMergedExport({ paths: ['a.md'], outputFile: '/out/All.pdf', profile: article });
		expect(plan.notes[0]?.destination).toBeNull();
		expect(plan.mergedDestination).toBe('/out/All.pdf');
	});

	it('appends a .pdf extension when the save dialog omitted one', () => {
		const plan = planMergedExport({ paths: ['a.md'], outputFile: '/out/All', profile: article });
		expect(plan.mergedDestination).toBe('/out/All.pdf');
	});
});

describe('destination helpers', () => {
	it('builds a single-note destination', () => {
		expect(singleNoteDestination('/out', 'Research/Chapter 1.md')).toBe('/out/Chapter 1.pdf');
	});

	it('trims a trailing slash from the output directory', () => {
		expect(singleNoteDestination('/out/', 'a.md')).toBe('/out/a.pdf');
	});

	it('does not double an existing extension', () => {
		expect(ensurePdfExtension('/out/a.pdf')).toBe('/out/a.pdf');
		expect(ensurePdfExtension('/out/a.PDF')).toBe('/out/a.PDF');
	});
});

/**
 * Renaming the output of a single-note export.
 *
 * The name comes from a text field, so it arrives with whatever the user typed in it: an
 * extension, stray spaces, a dot in the middle, path separators, or nothing at all.
 */
describe('renaming a single-note export', () => {
	it('uses the typed name in place of the note name', () => {
		expect(singleNoteDestination('/out', 'Research/Chapter 1.md', 'Introduction')).toBe('/out/Introduction.pdf');
	});

	it('does not add a second .pdf when the name already carries one', () => {
		expect(singleNoteDestination('/out', 'a.md', 'Report.pdf')).toBe('/out/Report.pdf');
		expect(singleNoteDestination('/out', 'a.md', 'Report.PDF')).toBe('/out/Report.pdf');
	});

	// The note-name path goes through `stemName`, which strips everything after the last
	// dot. A typed name must not: `Q3 2026.final` is a name, not a name plus an extension.
	it('keeps dots inside a typed name', () => {
		expect(singleNoteDestination('/out', 'a.md', 'Q3 2026.final')).toBe('/out/Q3 2026.final.pdf');
	});

	it('falls back to the note name when the field is empty or only spaces', () => {
		expect(singleNoteDestination('/out', 'Research/Chapter 1.md', '')).toBe('/out/Chapter 1.pdf');
		expect(singleNoteDestination('/out', 'Research/Chapter 1.md', '   ')).toBe('/out/Chapter 1.pdf');
		expect(singleNoteDestination('/out', 'Research/Chapter 1.md')).toBe('/out/Chapter 1.pdf');
	});

	// A typed name is one path segment, never a path: a slash in it must not create a
	// directory, and neither must it escape the chosen output directory.
	it('sanitises the typed name into a single safe segment', () => {
		expect(singleNoteDestination('/out', 'a.md', '../../etc/passwd')).toBe('/out/-..-etc-passwd.pdf');
		expect(singleNoteDestination('/out', 'a.md', 'a:b|c?d')).toBe('/out/a-b-c-d.pdf');
	});

	it('falls back to a placeholder rather than an empty file name', () => {
		expect(singleNoteDestination('/out', 'a.md', '...')).toBe('/out/untitled.pdf');
	});
});
