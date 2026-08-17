import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRef } from 'pdf-lib';
import type { OutlineNode } from '../core/outline';
import type { OutlineInjector } from '../core/pipeline';

/**
 * Writing the bookmark tree into a finished PDF.
 *
 * The tree itself is built in `src/core/outline.ts` from paged.js's page map, so the part
 * worth testing — nesting, level skips, merged documents — is tested headlessly. This file
 * is only the `pdf-lib` mechanics of turning that tree into `/Outlines` objects.
 */
export class PdfLibOutlineInjector implements OutlineInjector {
	async inject(pdf: Uint8Array, outline: readonly OutlineNode[]): Promise<Uint8Array> {
		if (outline.length === 0) return pdf;

		const document = await PDFDocument.load(pdf);
		const context = document.context;
		const pageRefs = document.getPages().map((page) => page.ref);
		if (pageRefs.length === 0) return pdf;

		const rootRef = context.nextRef();
		const { firstRef, lastRef, count } = writeLevel(outline, rootRef);
		if (firstRef === null || lastRef === null) return pdf;

		context.assign(
			rootRef,
			context.obj({
				Type: PDFName.of('Outlines'),
				First: firstRef,
				Last: lastRef,
				Count: PDFNumber.of(count),
			}),
		);
		document.catalog.set(PDFName.of('Outlines'), rootRef);
		document.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));

		return await document.save();

		/**
		 * Write one level of siblings and recurse. Returns the refs the parent needs, plus
		 * the count of *visible* descendants — a positive `Count` is what makes a node open
		 * in the reader's sidebar rather than collapsed.
		 */
		function writeLevel(
			nodes: readonly OutlineNode[],
			parentRef: PDFRef,
		): { firstRef: PDFRef | null; lastRef: PDFRef | null; count: number } {
			const refs = nodes.map(() => context.nextRef());
			let total = 0;

			nodes.forEach((node, index) => {
				const ref = refs[index];
				if (ref === undefined) return;

				const child = writeLevel(node.children, ref);
				const pageIndex = Math.min(Math.max(node.pageIndex, 0), pageRefs.length - 1);
				const destination = PDFArray.withContext(context);
				destination.push(pageRefs[pageIndex] as PDFRef);
				destination.push(PDFName.of('Fit'));

				const entry = PDFDict.withContext(context);
				entry.set(PDFName.of('Title'), PDFHexString.fromText(node.title));
				entry.set(PDFName.of('Parent'), parentRef);
				entry.set(PDFName.of('Dest'), destination);

				const previous = refs[index - 1];
				const next = refs[index + 1];
				if (previous !== undefined) entry.set(PDFName.of('Prev'), previous);
				if (next !== undefined) entry.set(PDFName.of('Next'), next);
				if (child.firstRef !== null && child.lastRef !== null) {
					entry.set(PDFName.of('First'), child.firstRef);
					entry.set(PDFName.of('Last'), child.lastRef);
					entry.set(PDFName.of('Count'), PDFNumber.of(child.count));
				}

				context.assign(ref, entry);
				total += 1 + child.count;
			});

			return { firstRef: refs[0] ?? null, lastRef: refs[refs.length - 1] ?? null, count: total };
		}
	}
}
