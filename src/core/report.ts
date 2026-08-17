import type { ReportEntry, ReportSeverity } from './types';

/**
 * Accumulates everything an export wants to tell the user afterwards.
 *
 * Deliberately has no clock and no I/O: entries are appended in the order they happen and
 * compared verbatim by tests. Timing, if ever wanted, belongs to the shell.
 */
export class ExportReport {
	private readonly entries: ReportEntry[] = [];
	private readonly onceCodes = new Set<string>();

	add(severity: ReportSeverity, code: string, message: string, subject?: string): void {
		this.entries.push(subject === undefined ? { severity, code, message } : { severity, code, message, subject });
	}

	info(code: string, message: string, subject?: string): void {
		this.add('info', code, message, subject);
	}

	warn(code: string, message: string, subject?: string): void {
		this.add('warning', code, message, subject);
	}

	error(code: string, message: string, subject?: string): void {
		this.add('error', code, message, subject);
	}

	/**
	 * Record `code` at most once per report. The zotero-manager gate and the
	 * citeSuggestTemplate-shape notice both use this: they must report once, not once per
	 * note in a 200-note bulk export.
	 */
	once(severity: ReportSeverity, code: string, message: string, subject?: string): boolean {
		if (this.onceCodes.has(code)) return false;
		this.onceCodes.add(code);
		this.add(severity, code, message, subject);
		return true;
	}

	has(code: string): boolean {
		return this.entries.some((entry) => entry.code === code);
	}

	get all(): readonly ReportEntry[] {
		return this.entries;
	}

	get errors(): readonly ReportEntry[] {
		return this.entries.filter((entry) => entry.severity === 'error');
	}

	get warnings(): readonly ReportEntry[] {
		return this.entries.filter((entry) => entry.severity === 'warning');
	}

	/** Merge another report in, preserving order and the once-only bookkeeping. */
	absorb(other: ExportReport): void {
		for (const entry of other.all) {
			this.entries.push(entry);
		}
		for (const code of other.onceCodes) {
			this.onceCodes.add(code);
		}
	}

	toLines(): string[] {
		return this.entries.map((entry) => {
			const subject = entry.subject === undefined ? '' : ` [${entry.subject}]`;
			return `${entry.severity.toUpperCase()} ${entry.code}: ${entry.message}${subject}`;
		});
	}
}
