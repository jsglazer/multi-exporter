import type { MarginBoxContent, PageConfig, PageFurniture, PageSize } from './types';

/**
 * `@page` CSS generation.
 *
 * Page furniture is CSS, not a template string. Chromium's `printToPDF` header/footer API
 * offers about five classes and honours no margin boxes at all, which is why running heads
 * that track the current section, recto/verso furniture, and a suppressed first-page header
 * are unreachable through it. paged.js implements the real thing, so after pagination the
 * furniture is made of ordinary elements and the PDF is printed at zero margin.
 *
 * Pure string generation: given a `PageConfig` this always produces the same stylesheet,
 * which is what makes it testable without a browser.
 */

export const PAGE_SIZES: Record<PageSize, { width: string; height: string }> = {
	A4: { width: '210mm', height: '297mm' },
	A5: { width: '148mm', height: '210mm' },
	Letter: { width: '8.5in', height: '11in' },
	Legal: { width: '8.5in', height: '14in' },
	Tabloid: { width: '11in', height: '17in' },
};

const MARGIN_BOXES: [keyof PageFurniture, string][] = [
	['topLeft', '@top-left'],
	['topCenter', '@top-center'],
	['topRight', '@top-right'],
	['bottomLeft', '@bottom-left'],
	['bottomCenter', '@bottom-center'],
	['bottomRight', '@bottom-right'],
];

/** Full paged-media stylesheet for a profile's page configuration. */
export function buildPageCss(config: PageConfig): string {
	const blocks: string[] = [];
	blocks.push(basePageBlock(config));

	if (config.suppressFirstPageFurniture) {
		blocks.push(suppressBlock(':first'));
	}
	if (config.rectoFurniture !== undefined && hasContent(config.rectoFurniture)) {
		blocks.push(furnitureBlock(':right', config.rectoFurniture));
	}
	if (config.versoFurniture !== undefined && hasContent(config.versoFurniture)) {
		blocks.push(furnitureBlock(':left', config.versoFurniture));
	}

	blocks.push(breakControlBlock(config));
	return blocks.join('\n\n');
}

function basePageBlock(config: PageConfig): string {
	const size = PAGE_SIZES[config.size];
	const dimensions =
		config.orientation === 'landscape' ? `${size.height} ${size.width}` : `${size.width} ${size.height}`;
	const lines = [
		'@page {',
		`\tsize: ${dimensions};`,
		`\tmargin: ${config.margins.top} ${config.margins.right} ${config.margins.bottom} ${config.margins.left};`,
		...marginBoxLines(config.furniture),
		'}',
	];
	return lines.join('\n');
}

function furnitureBlock(selector: string, furniture: PageFurniture): string {
	return [`@page ${selector} {`, ...marginBoxLines(furniture), '}'].join('\n');
}

/**
 * `@page :first` with every margin box emptied. An empty `content` is what actually removes
 * a running head on the opening page — omitting the box inherits the general rule instead.
 */
function suppressBlock(selector: string): string {
	const lines = MARGIN_BOXES.map(([, box]) => `\t${box} { content: none; }`);
	return [`@page ${selector} {`, ...lines, '}'].join('\n');
}

function marginBoxLines(furniture: PageFurniture): string[] {
	const lines: string[] = [];
	for (const [key, box] of MARGIN_BOXES) {
		const value = furniture[key];
		if (value === undefined || value.content.trim() === '') continue;
		lines.push(`\t${box} { content: ${value.content}; }`);
	}
	return lines;
}

function breakControlBlock(config: PageConfig): string {
	return [
		'.pagedjs_page_content > div {',
		`\torphans: ${config.orphans};`,
		`\twidows: ${config.widows};`,
		'}',
	].join('\n');
}

function hasContent(furniture: PageFurniture): boolean {
	return MARGIN_BOXES.some(([key]) => {
		const value = furniture[key];
		return value !== undefined && value.content.trim() !== '';
	});
}

/** Quote a literal string for use in a CSS `content` value. */
export function cssString(value: string): string {
	return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** `content` value for a running head that tracks the nearest preceding heading. */
export function runningHeading(named: string): MarginBoxContent {
	return { content: `string(${named})` };
}

/**
 * The `string-set` rules that make `runningHeading` work: each named string is captured
 * from the headings at the given level, so the margin box shows the current section.
 */
export function buildStringSetCss(named: string, headingSelector: string): string {
	return [`${headingSelector} {`, `\tstring-set: ${named} content(text);`, '}'].join('\n');
}
