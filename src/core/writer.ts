import { ExportReport } from './report';

/**
 * Every filesystem write goes through this interface.
 *
 * Exports land outside the vault, so an accidental real write during a test run would
 * pollute the developer's machine. `src/core/` therefore imports no `fs`: it writes through
 * an injected `FileWriter`, tests inject `InMemoryFileWriter`, and only `src/shell/` ever
 * constructs the node-backed one.
 *
 * Paths handled here are OS destination paths (absolute, outside the vault), not vault
 * paths, so they keep their leading slash and are split rather than normalised.
 */

export interface FileWriter {
	ensureDir(dirPath: string): Promise<void>;
	exists(filePath: string): Promise<boolean>;
	writeFile(filePath: string, data: Uint8Array): Promise<void>;
}

/** Directory portion of an OS path, preserving a leading slash. `''` if there is none. */
export function dirNameOf(filePath: string): string {
	const slash = filePath.lastIndexOf('/');
	if (slash === -1) return '';
	return slash === 0 ? '/' : filePath.slice(0, slash);
}

/** Final segment of an OS path. */
export function baseNameOf(filePath: string): string {
	const slash = filePath.lastIndexOf('/');
	return slash === -1 ? filePath : filePath.slice(slash + 1);
}

/** Fully in-memory `FileWriter`. Used by every test, and by nothing in `src/shell/`. */
export class InMemoryFileWriter implements FileWriter {
	readonly files = new Map<string, Uint8Array>();
	readonly dirs = new Set<string>();

	ensureDir(dirPath: string): Promise<void> {
		const absolute = dirPath.startsWith('/');
		const segments = dirPath.split('/').filter((segment) => segment.length > 0);
		let accumulated = absolute ? '' : null;
		for (const segment of segments) {
			accumulated = accumulated === null ? segment : `${accumulated}/${segment}`;
			this.dirs.add(accumulated);
		}
		return Promise.resolve();
	}

	exists(filePath: string): Promise<boolean> {
		return Promise.resolve(this.files.has(filePath) || this.dirs.has(filePath));
	}

	writeFile(filePath: string, data: Uint8Array): Promise<void> {
		this.files.set(filePath, data);
		return Promise.resolve();
	}

	/** Convenience for assertions. */
	get paths(): string[] {
		return [...this.files.keys()].sort();
	}
}

export interface ExportItem {
	/** Destination path, including the `.pdf` extension. */
	destination: string;
	/** Vault path this item came from, for the report. */
	sourcePath: string;
	bytes: Uint8Array;
}

export interface WriteOutcome {
	/** Paths actually written, in the order they were written. */
	written: string[];
	/** `[requested, actual]` for every item whose name had to be disambiguated. */
	renamed: [string, string][];
}

/**
 * Write a planned set of exports.
 *
 * Parent directories are created first — Separate mode reproduces the source hierarchy, so
 * most writes land in a directory that does not exist yet. A destination that already
 * exists is never overwritten silently: the file gets a ` 2`, ` 3`, … suffix and the
 * substitution is recorded, because a bulk export quietly clobbering a previous run's
 * output is the kind of failure that is noticed far too late.
 */
export async function writeExportItems(
	items: readonly ExportItem[],
	writer: FileWriter,
	report: ExportReport,
): Promise<WriteOutcome> {
	const written: string[] = [];
	const renamed: [string, string][] = [];
	const claimed = new Set<string>();

	for (const item of items) {
		const dir = dirNameOf(item.destination);
		if (dir !== '' && dir !== '/') await writer.ensureDir(dir);

		const destination = await uniqueDestination(item.destination, writer, claimed);
		claimed.add(destination);
		if (destination !== item.destination) {
			renamed.push([item.destination, destination]);
			report.warn(
				'destination-exists',
				`A file already existed at that path, so the export was written alongside it as ${baseNameOf(destination)}.`,
				item.sourcePath,
			);
		}

		await writer.writeFile(destination, item.bytes);
		written.push(destination);
	}

	return { written, renamed };
}

/**
 * First free `name.pdf`, `name 2.pdf`, `name 3.pdf`, … Numbering is derived from the path
 * alone — no clock, no randomness — so two runs against the same starting state produce
 * byte-identical file names.
 */
async function uniqueDestination(
	destination: string,
	writer: FileWriter,
	claimed: ReadonlySet<string>,
): Promise<string> {
	const taken = async (candidate: string): Promise<boolean> =>
		claimed.has(candidate) || (await writer.exists(candidate));
	if (!(await taken(destination))) return destination;

	const dir = dirNameOf(destination);
	const base = baseNameOf(destination);
	const dot = base.lastIndexOf('.');
	const stem = dot <= 0 ? base : base.slice(0, dot);
	const extension = dot <= 0 ? '' : base.slice(dot);
	const prefix = dir === '' ? '' : dir === '/' ? '/' : `${dir}/`;

	for (let counter = 2; ; counter++) {
		const candidate = `${prefix}${stem} ${counter}${extension}`;
		if (!(await taken(candidate))) return candidate;
	}
}
