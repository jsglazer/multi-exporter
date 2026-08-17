import type {
	ExportBackend,
	ExportRequest,
	ExportResult,
	PaginateRequest,
	PaginateResult,
} from '../../src/core/backend';
import { NODE_TYPE_ELEMENT } from '../../src/core/dom';
import type { NodeLike } from '../../src/core/dom';
import type { MockElement } from './mock-dom';

/**
 * The **test-only** second backend.
 *
 * v1 ships exactly one real backend (paged.js plus webview `printToPDF`). This one exists to
 * prove the `ExportBackend` seam actually is a seam — that the pipeline can be driven end to
 * end with no Electron, no Chromium and no PDF — not to be a second implementation. It never
 * ships: nothing under `src/` imports it.
 *
 * Pagination is faked with a fixed, deterministic rule: a new page every `linesPerPage`
 * block-level elements. That is enough to give headings distinct page indices, which is all
 * the outline builder needs.
 */
export class FakeBackend implements ExportBackend {
	readonly id = 'fake';
	readonly label = 'Fake (tests only)';

	readonly paginateCalls: PaginateRequest[] = [];
	readonly exportCalls: ExportRequest[] = [];
	disposed = false;

	constructor(private readonly linesPerPage = 2) {}

	paginate(request: PaginateRequest): Promise<PaginateResult> {
		this.paginateCalls.push(request);
		const { headings, pageCount } = layout(request.html, this.linesPerPage);
		return Promise.resolve({ pageCount, headings });
	}

	export(request: ExportRequest): Promise<ExportResult> {
		this.exportCalls.push(request);
		request.onProgress?.(0.5, 'faking');

		const headings: ExportResult['headings'] = [];
		const documentStartPages: number[] = [];
		let pageCursor = 0;

		for (const document of request.documents) {
			documentStartPages.push(pageCursor);
			const laid = layout(document.html, this.linesPerPage);
			for (const heading of laid.headings) {
				headings.push({ ...heading, pageIndex: heading.pageIndex + pageCursor });
			}
			pageCursor += Math.max(laid.pageCount, 1);
		}

		// A recognisable, deterministic stand-in for PDF bytes.
		const pdf = new TextEncoder().encode(
			`%FAKE-PDF ${request.profile.id} pages=${pageCursor} css=${request.css.length}`,
		);
		return Promise.resolve({ pdf, pageCount: pageCursor, headings, documentStartPages });
	}

	dispose(): Promise<void> {
		this.disposed = true;
		return Promise.resolve();
	}
}

/**
 * Minimal HTML "layout": counts block elements, assigns pages, and records where each
 * heading landed. Regex-based on purpose — a parser here would be a second thing to trust.
 */
function layout(html: string, linesPerPage: number): { headings: PaginateResult['headings']; pageCount: number } {
	const headings: PaginateResult['headings'] = [];
	const blocks = [...html.matchAll(/<(h[1-6]|p|div|section|ol|ul|table)\b[^>]*>([\s\S]*?)<\/\1>/g)];

	blocks.forEach((block, index) => {
		const tag = block[1] ?? '';
		const pageIndex = Math.floor(index / linesPerPage);
		const level = /^h([1-6])$/.exec(tag)?.[1];
		if (level === undefined) return;
		const title = (block[2] ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
		if (title === '') return;
		headings.push({ level: Number(level), title, pageIndex });
	});

	return { headings, pageCount: Math.max(1, Math.ceil(blocks.length / linesPerPage)) };
}

/**
 * Serialise a mock root's *children*, mirroring what the real `DocumentTransforms.serialize`
 * returns (`root.innerHTML`). Serialising the root element itself would wrap the document in
 * a single block, which is not what the backend receives.
 */
export function serializeMockChildren(node: NodeLike): string {
	const children: NodeLike[] = [];
	for (let i = 0; i < node.childNodes.length; i++) {
		const child = node.childNodes[i];
		if (child !== undefined) children.push(child);
	}
	return children.map(serializeMock).join('');
}

/** Serialise a mock tree to HTML, so the fake backend has something to "lay out". */
export function serializeMock(node: NodeLike): string {
	if (node.nodeType !== NODE_TYPE_ELEMENT) return node.textContent ?? '';
	const element = node as MockElement;
	const tag = element.nodeName.toLowerCase();
	const attrs = Object.entries(element.attrs)
		.map(([name, value]) => ` ${name}="${value}"`)
		.join('');
	const classes = element.classes.size === 0 ? '' : ` class="${[...element.classes].join(' ')}"`;
	const inner = element.childNodes.map(serializeMock).join('');
	return `<${tag}${classes}${attrs}>${inner}</${tag}>`;
}
