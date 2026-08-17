import { describe, expect, it } from 'vitest';
import { ExportReport } from '../src/core/report';
import { baseNameOf, dirNameOf, InMemoryFileWriter, writeExportItems } from '../src/core/writer';
import type { ExportItem } from '../src/core/writer';

/**
 * Deterministic test requirement: "Unit-test file export logic using an in-memory mock
 * writer."
 *
 * Exports land outside the vault, so this is the one piece of logic that could pollute a
 * machine during an automated run. Every assertion here runs against `InMemoryFileWriter`;
 * nothing in this file can touch a real disk.
 */

const bytes = (text: string): Uint8Array => Uint8Array.from([...text].map((char) => char.charCodeAt(0)));

function item(destination: string, sourcePath = 'note.md', body = 'pdf'): ExportItem {
	return { destination, sourcePath, bytes: bytes(body) };
}

describe('path helpers', () => {
	it('splits absolute OS paths without losing the leading slash', () => {
		expect(dirNameOf('/Users/x/Out/Note.pdf')).toBe('/Users/x/Out');
		expect(baseNameOf('/Users/x/Out/Note.pdf')).toBe('Note.pdf');
	});

	it('handles a file at the filesystem root', () => {
		expect(dirNameOf('/Note.pdf')).toBe('/');
		expect(dirNameOf('Note.pdf')).toBe('');
	});
});

describe('writeExportItems', () => {
	it('writes each item and returns the paths written', async () => {
		const writer = new InMemoryFileWriter();
		const report = new ExportReport();
		const outcome = await writeExportItems(
			[item('/out/One.pdf', 'One.md'), item('/out/Two.pdf', 'Two.md')],
			writer,
			report,
		);

		expect(outcome.written).toEqual(['/out/One.pdf', '/out/Two.pdf']);
		expect(writer.paths).toEqual(['/out/One.pdf', '/out/Two.pdf']);
		expect(report.warnings).toHaveLength(0);
	});

	// Separate mode reproduces the source hierarchy, so most writes land in a directory
	// that does not exist yet.
	it('creates every parent directory first', async () => {
		const writer = new InMemoryFileWriter();
		await writeExportItems([item('/out/Research/Data/Table.pdf')], writer, new ExportReport());

		expect(writer.dirs.has('/out')).toBe(true);
		expect(writer.dirs.has('/out/Research')).toBe(true);
		expect(writer.dirs.has('/out/Research/Data')).toBe(true);
	});

	it('writes the exact bytes it was given', async () => {
		const writer = new InMemoryFileWriter();
		await writeExportItems([item('/out/One.pdf', 'One.md', 'PDF-1.7')], writer, new ExportReport());
		expect(writer.files.get('/out/One.pdf')).toEqual(bytes('PDF-1.7'));
	});

	// A bulk export silently clobbering the previous run's output is noticed far too late.
	it('never overwrites an existing file, and reports the substitution', async () => {
		const writer = new InMemoryFileWriter();
		await writer.writeFile('/out/One.pdf', bytes('older'));
		const report = new ExportReport();

		const outcome = await writeExportItems([item('/out/One.pdf', 'One.md', 'newer')], writer, report);

		expect(outcome.written).toEqual(['/out/One 2.pdf']);
		expect(outcome.renamed).toEqual([['/out/One.pdf', '/out/One 2.pdf']]);
		expect(writer.files.get('/out/One.pdf')).toEqual(bytes('older'));
		expect(report.has('destination-exists')).toBe(true);
	});

	it('disambiguates collisions within a single run', async () => {
		const writer = new InMemoryFileWriter();
		const outcome = await writeExportItems(
			[item('/out/Note.pdf', 'a/Note.md'), item('/out/Note.pdf', 'b/Note.md'), item('/out/Note.pdf', 'c/Note.md')],
			writer,
			new ExportReport(),
		);
		expect(outcome.written).toEqual(['/out/Note.pdf', '/out/Note 2.pdf', '/out/Note 3.pdf']);
	});

	// Numbering is derived from the path alone — no clock, no randomness — so the same
	// starting state always produces the same names.
	it('is deterministic across runs', async () => {
		const run = async (): Promise<string[]> => {
			const writer = new InMemoryFileWriter();
			await writer.writeFile('/out/Note.pdf', bytes('existing'));
			const outcome = await writeExportItems(
				[item('/out/Note.pdf'), item('/out/Note.pdf')],
				writer,
				new ExportReport(),
			);
			return outcome.written;
		};
		expect(await run()).toEqual(await run());
	});

	it('writes nothing for an empty plan', async () => {
		const writer = new InMemoryFileWriter();
		const outcome = await writeExportItems([], writer, new ExportReport());
		expect(outcome.written).toEqual([]);
		expect(writer.paths).toEqual([]);
	});
});

describe('InMemoryFileWriter', () => {
	it('reports directories it has created as existing', async () => {
		const writer = new InMemoryFileWriter();
		await writer.ensureDir('/out/nested');
		expect(await writer.exists('/out')).toBe(true);
		expect(await writer.exists('/out/nested')).toBe(true);
		expect(await writer.exists('/elsewhere')).toBe(false);
	});
});
