import type { BenchmarkWorkload } from '../src/benchmark-workloads.ts';
import type { EngineResult } from './engine-comparison-report.ts';

export type BenchmarkChangeStatus = 'regression' | 'improvement' | 'within-jitter';
export type BenchmarkCommentStatus = 'warning' | 'celebration' | 'regular';

/** A workload timing compared with the same engine and workload in the baseline run. */
export interface BenchmarkChange {
    baselineMedianMs: number;
    changePercent: number;
    currentMedianMs: number;
    engineId: string;
    engineLabel: string;
    operationsPerSample: number;
    status: BenchmarkChangeStatus;
    workload: string;
    workloadArea: string;
    workloadProvenance: BenchmarkWorkload['provenance'];
}

/** Component size for one engine in the current benchmark run. */
export interface BenchmarkEngineSize {
    binarySizeBytes: number;
    engineId: string;
    engineLabel: string;
}

/** Per-workload timing changes grouped by their effect size. */
export interface BenchmarkComparison {
    changes: BenchmarkChange[];
    engineSizes: BenchmarkEngineSize[];
    improvements: BenchmarkChange[];
    medianChangePercent: number | null;
    regressions: BenchmarkChange[];
    skippedWorkloads: string[];
    status: BenchmarkCommentStatus;
    thresholdPercent: number;
}

/** Inputs used to write a repeatable pull request comment for one benchmark run. */
export interface BenchmarkCommentDetails {
    baselineSha?: string;
    chartUrl?: string;
    chartUrls?: { dark: string; light: string };
    comparison?: BenchmarkComparison;
    currentSha: string;
    noBaselineReason?: string;
    reportRunUrl: string;
}

/**
 * Compares workload medians from matching engine configurations and classifies changes beyond the jitter threshold.
 *
 * @param current - Results produced by the current revision.
 * @param baseline - Results produced by the baseline revision.
 * @param thresholdPercent - Minimum absolute timing change, in percent, that counts as significant.
 * @returns Comparable timing changes, skipped rows, and an overall comment status.
 */
export function compareBenchmarkResults(
    current: readonly EngineResult[],
    baseline: readonly EngineResult[],
    thresholdPercent = 10,
): BenchmarkComparison {
    if (!Number.isFinite(thresholdPercent) || thresholdPercent < 0 || thresholdPercent > 100) {
        throw new Error('Benchmark jitter threshold must be a finite percentage from 0 through 100');
    }

    const currentEngines = indexEngines(current, 'current');
    const baselineEngines = indexEngines(baseline, 'baseline');
    const changes: BenchmarkChange[] = [];
    const skippedWorkloads: string[] = [];

    for (const engine of current) {
        const baselineEngine = baselineEngines.get(engine.id);
        if (!baselineEngine) {
            skippedWorkloads.push(`${engine.id}: engine is not present in baseline`);
            continue;
        }

        const currentWorkloads = indexWorkloads(engine);
        const baselineWorkloads = indexWorkloads(baselineEngine);
        for (const workload of engine.workloads) {
            const baselineWorkload = baselineWorkloads.get(workload.name);
            if (!baselineWorkload) {
                skippedWorkloads.push(`${engine.id}/${workload.name}: workload is not present in baseline`);
                continue;
            }
            if (!hasMatchingDefinition(workload, baselineWorkload)) {
                skippedWorkloads.push(`${engine.id}/${workload.name}: workload definition changed`);
                continue;
            }

            const baselineMedianMs = median(baselineWorkload.samplesMs);
            if (baselineMedianMs === 0) {
                skippedWorkloads.push(`${engine.id}/${workload.name}: baseline median is 0 ms`);
                continue;
            }

            const currentMedianMs = median(workload.samplesMs);
            const changePercent = ((currentMedianMs - baselineMedianMs) / baselineMedianMs) * 100;
            changes.push({
                baselineMedianMs,
                changePercent,
                currentMedianMs,
                engineId: engine.id,
                engineLabel: engine.label,
                operationsPerSample: workload.operationsPerSample,
                status:
                    changePercent > thresholdPercent
                        ? 'regression'
                        : changePercent < -thresholdPercent
                          ? 'improvement'
                          : 'within-jitter',
                workloadArea: workload.area,
                workload: workload.name,
                workloadProvenance: workload.provenance,
            });
        }

        for (const workload of baselineEngine.workloads) {
            if (!currentWorkloads.has(workload.name)) {
                skippedWorkloads.push(`${engine.id}/${workload.name}: workload is not present in current run`);
            }
        }
    }

    for (const engine of baseline) {
        if (!currentEngines.has(engine.id)) skippedWorkloads.push(`${engine.id}: engine is not present in current run`);
    }

    const regressions = changes.filter(({ status }) => status === 'regression').sort(compareLargestFirst);
    const improvements = changes
        .filter(({ status }) => status === 'improvement')
        .sort((left, right) => left.changePercent - right.changePercent);

    return {
        changes,
        engineSizes: current.map(({ binarySizeBytes, id, label }) => ({
            binarySizeBytes,
            engineId: id,
            engineLabel: label,
        })),
        improvements,
        medianChangePercent: changes.length > 0 ? median(changes.map(({ changePercent }) => changePercent)) : null,
        regressions,
        skippedWorkloads,
        status: regressions.length > 0 ? 'warning' : improvements.length > 0 ? 'celebration' : 'regular',
        thresholdPercent,
    };
}

/**
 * Formats a concise pull request comment with significant changes and a link to the full matrix report.
 *
 * @param details - Revision identifiers, comparison data, and report links.
 * @returns Markdown with a stable marker used to update the same comment on later runs.
 */
export function formatBenchmarkComment(details: BenchmarkCommentDetails): string {
    const lines: string[] = [];
    const comparison = details.comparison;

    if (!comparison || !details.baselineSha) {
        lines.push(
            '## 📊 Runtime benchmark report',
            '',
            escapeMarkdown(details.noBaselineReason ?? 'No matching baseline benchmark run is available.'),
            '',
            `Current revision: \`${escapeMarkdown(shortSha(details.currentSha))}\`.`,
        );
    } else {
        const heading =
            comparison.status === 'warning'
                ? '## ⚠️ Benchmark regressions detected'
                : comparison.status === 'celebration'
                  ? '## 🎉 Significant benchmark improvements'
                  : '## 📊 Runtime benchmark results';
        const direction =
            comparison.medianChangePercent === null
                ? 'No comparable workload timings.'
                : `Median change across comparable engine/workload pairs: ${formatSignedPercent(comparison.medianChangePercent)}.`;
        lines.push(
            heading,
            '',
            `Compared \`${escapeMarkdown(shortSha(details.currentSha))}\` with baseline \`${escapeMarkdown(shortSha(details.baselineSha))}\`.`,
            `Changes within ±${comparison.thresholdPercent}% are treated as runner jitter. Lower time is better. ${direction}`,
            '',
        );

        if (comparison.regressions.length > 0) appendChangeTable(lines, 'Regressions', comparison.regressions);
        if (comparison.improvements.length > 0) appendChangeTable(lines, 'Improvements', comparison.improvements);
        if (comparison.regressions.length === 0 && comparison.improvements.length === 0) {
            lines.push('No workload changed beyond the jitter threshold.', '');
        }
        if (comparison.skippedWorkloads.length > 0) {
            lines.push(
                `${comparison.skippedWorkloads.length} workload comparison(s) were skipped because the baseline or definition did not match.`,
                '',
            );
        }
    }

    lines.push(`[Full benchmark matrix report](${details.reportRunUrl}).`);
    if (details.chartUrls) {
        const lightUrl = escapeHtmlAttribute(details.chartUrls.light);
        const darkUrl = escapeHtmlAttribute(details.chartUrls.dark);
        lines.push(
            '',
            '<picture>',
            `  <source media="(prefers-color-scheme: dark)" type="image/svg+xml" srcset="${darkUrl}">`,
            `  <source media="(prefers-color-scheme: light)" type="image/svg+xml" srcset="${lightUrl}">`,
            `  <img alt="Benchmark timing changes" src="${lightUrl}">`,
            '</picture>',
            '',
            `[Download light SVG](${details.chartUrls.light}) · [Download dark SVG](${details.chartUrls.dark})`,
        );
    } else if (details.chartUrl) {
        lines.push(
            '',
            `![Benchmark timing changes](${details.chartUrl})`,
            '',
            `[Download the SVG comparison chart](${details.chartUrl}).`,
        );
    }
    return lines.join('\n');
}

const SVG_WIDTH = 1120;
const MAX_CHANGES_PER_DIRECTION = 12;
const SVG_THEMES = {
    light: {
        background: '#FFFFFF',
        surface: '#F6F8FA',
        foreground: '#1F2328',
        muted: '#59636E',
        rule: '#D1D9E0',
        grid: '#E7ECF0',
        regression: '#CF222E',
        improvement: '#1A7F37',
        jitter: '#FFF8C5',
        jitterEdge: '#D4A72C',
        neutral: '#68727D',
    },
    dark: {
        background: '#0D1117',
        surface: '#161B22',
        foreground: '#E6EDF3',
        muted: '#8B949E',
        rule: '#30363D',
        grid: '#252C34',
        regression: '#FF7B72',
        improvement: '#3FB950',
        jitter: '#3D2E00',
        jitterEdge: '#9E6A03',
        neutral: '#8B949E',
    },
} as const;

type SvgThemeName = keyof typeof SVG_THEMES;
type SvgFont = 'ui' | 'mono';

/**
 * Renders the light-theme benchmark chart for the PR comment.
 *
 * @param comparison - Timing changes and jitter classification from a matrix comparison.
 * @returns Standalone light-theme SVG source for GitHub's image attachment upload.
 */
export async function formatBenchmarkChangeSvg(comparison: BenchmarkComparison): Promise<string> {
    return (await formatBenchmarkChangeSvgs(comparison)).light;
}

/** Renders light- and dark-theme SVG charts from the same benchmark comparison. */
export async function formatBenchmarkChangeSvgs(
    comparison: BenchmarkComparison,
): Promise<{ dark: string; light: string }> {
    return {
        dark: renderBenchmarkSvg(comparison, 'dark'),
        light: renderBenchmarkSvg(comparison, 'light'),
    };
}

function renderBenchmarkSvg(comparison: BenchmarkComparison, themeName: SvgThemeName): string {
    const theme = SVG_THEMES[themeName];
    const regressions = comparison.regressions.slice(0, MAX_CHANGES_PER_DIRECTION);
    const improvements = comparison.improvements.slice(0, MAX_CHANGES_PER_DIRECTION);
    const visibleChanges = [...regressions, ...improvements];
    const withinJitterCount = comparison.changes.filter(({ status }) => status === 'within-jitter').length;
    const skippedCount = comparison.skippedWorkloads.length;
    const medianChange =
        comparison.medianChangePercent === null ? 'n/a' : formatSignedPercent(comparison.medianChangePercent);
    const sizeColumns = 3;
    const sizeCardWidth = 344;
    const sizeCardHeight = 62;
    const sizeCardGap = 10;
    const sizeRows = Math.ceil(comparison.engineSizes.length / sizeColumns);
    const sizeSectionTop = 184;
    const sizeCardsTop = sizeSectionTop + 24;
    const sizeSectionBottom = sizeCardsTop + sizeRows * (sizeCardHeight + sizeCardGap);
    const timingHeadingTop = Math.max(sizeSectionBottom + 20, sizeCardsTop + 16);
    const maximumChange = Math.max(
        25,
        comparison.thresholdPercent * 1.5,
        ...visibleChanges.map(({ changePercent }) => Math.abs(changePercent)),
    );
    const axisMaximum = Math.ceil(maximumChange * 1.08);
    const plotX = 480;
    const plotWidth = 520;
    const zeroX = plotX + plotWidth / 2;
    const changeColumnX = 1012;
    const plotScale = plotWidth / 2 / axisMaximum;
    const rowLayouts: {
        change: BenchmarkChange;
        top: number;
        height: number;
        areaLines: string[];
        engineLines: string[];
        contextLines: string[];
    }[] = [];
    let cursorY = timingHeadingTop + 62;

    for (const changes of [regressions, improvements]) {
        if (changes.length === 0) continue;
        cursorY += 22;
        for (const change of changes) {
            const areaLines = wrapWords(change.workloadArea, 48);
            const engineLines = wrapWords(`${change.workload} · ${change.engineLabel}`, 72);
            const contextLines = wrapWords(
                `${change.workloadProvenance} · ${formatInputsPerSample(change.operationsPerSample)} · median ${formatMilliseconds(change.baselineMedianMs)} → ${formatMilliseconds(change.currentMedianMs)} ms`,
                72,
            );
            const contentHeight = areaLines.length * 15 + engineLines.length * 12 + contextLines.length * 12;
            const height = Math.max(46, contentHeight + 6);
            rowLayouts.push({ change, top: cursorY, height, areaLines, engineLines, contextLines });
            cursorY += height;
        }
    }

    const plotTop = timingHeadingTop + 64;
    const plotBottom = Math.max(plotTop + 62, cursorY + 2);
    const chartHeight = plotBottom + 58;
    const parts: string[] = [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_WIDTH}" height="${chartHeight}" viewBox="0 0 ${SVG_WIDTH} ${chartHeight}" role="img" aria-labelledby="chart-title chart-description">`,
        `<title id="chart-title">Runtime benchmark changes, ${themeName} theme</title>`,
        '<desc id="chart-description">Benchmark timing medians, engine component sizes, and workload changes outside the jitter threshold.</desc>',
        `<rect width="${SVG_WIDTH}" height="${chartHeight}" fill="${theme.background}"/>`,
        svgText(32, 42, 'Runtime benchmark changes', theme.foreground, 25, 700),
        svgText(
            32,
            66,
            `Lower time is better · bars show median change · jitter threshold ±${comparison.thresholdPercent}%`,
            theme.muted,
            13,
        ),
    ];

    const regressionCount = comparison.regressions.length;
    const improvementCount = comparison.improvements.length;
    const summaryCards = [
        { label: 'PAIRS', value: formatCount(comparison.changes.length), color: theme.foreground },
        { label: 'REGRESSIONS', value: formatCount(regressionCount), color: theme.regression },
        { label: 'IMPROVEMENTS', value: formatCount(improvementCount), color: theme.improvement },
        { label: 'WITHIN JITTER', value: formatCount(withinJitterCount), color: theme.jitterEdge },
        { label: 'MEDIAN CHANGE', value: medianChange, color: theme.foreground },
        { label: 'SKIPPED', value: formatCount(skippedCount), color: theme.muted },
    ];
    const summaryTop = 82;
    const summaryCardWidth = 168;
    const summaryCardHeight = 70;
    const summaryGap = 8;
    for (const [index, card] of summaryCards.entries()) {
        const x = 32 + index * (summaryCardWidth + summaryGap);
        parts.push(
            svgRect(x, summaryTop, summaryCardWidth, summaryCardHeight, 8, theme.surface, theme.rule),
            svgText(x + 12, summaryTop + 24, card.label, theme.muted, 10, 700),
            svgText(x + 12, summaryTop + 52, card.value, card.color, 21, 700, 'mono'),
        );
    }

    parts.push(
        svgText(32, sizeSectionTop, 'COMPONENT SIZE BY ENGINE', theme.foreground, 12, 700),
        svgText(1088, sizeSectionTop, 'Current build · change vs QuickJS', theme.muted, 11, 400, 'ui', 'end'),
    );
    const quickjsSize = comparison.engineSizes.find(({ engineId }) => engineId === 'quickjs')?.binarySizeBytes;
    if (comparison.engineSizes.length === 0) {
        parts.push(svgText(32, sizeCardsTop + 20, 'Component size data unavailable', theme.muted, 12));
    }
    for (const [index, engine] of comparison.engineSizes.entries()) {
        const column = index % sizeColumns;
        const row = Math.floor(index / sizeColumns);
        const x = 32 + column * (sizeCardWidth + sizeCardGap);
        const y = sizeCardsTop + row * (sizeCardHeight + sizeCardGap);
        const delta = sizeDelta(engine.binarySizeBytes, quickjsSize, engine.engineId === 'quickjs');
        parts.push(
            svgRect(x, y, sizeCardWidth, sizeCardHeight, 8, theme.surface, theme.rule),
            svgText(x + 12, y + 21, engine.engineLabel, theme.foreground, 12, 600),
            svgText(x + 12, y + 45, delta, theme.muted, 10.5, 400),
            svgText(
                x + sizeCardWidth - 12,
                y + 44,
                formatBytes(engine.binarySizeBytes),
                theme.foreground,
                14,
                650,
                'mono',
                'end',
            ),
        );
    }

    const displayNote = [
        regressionCount > MAX_CHANGES_PER_DIRECTION
            ? `top ${MAX_CHANGES_PER_DIRECTION} of ${regressionCount} regressions`
            : countLabel(regressionCount, 'regression', 'regressions'),
        improvementCount > MAX_CHANGES_PER_DIRECTION
            ? `top ${MAX_CHANGES_PER_DIRECTION} of ${improvementCount} improvements`
            : countLabel(improvementCount, 'improvement', 'improvements'),
    ].join(' · ');
    parts.push(
        svgText(32, timingHeadingTop, 'TIMING CHANGES OUTSIDE JITTER', theme.foreground, 12, 700),
        svgText(1088, timingHeadingTop, displayNote, theme.muted, 10.5, 400, 'ui', 'end'),
        svgText(
            32,
            timingHeadingTop + 21,
            'Workload and engine context · baseline → current median · lower is better',
            theme.muted,
            11,
        ),
        svgText(changeColumnX, timingHeadingTop + 38, 'CHANGE', theme.muted, 10, 700, 'ui', 'start'),
    );

    if (visibleChanges.length === 0) {
        const message =
            comparison.changes.length === 0
                ? 'No comparable workload timings in this run.'
                : `All ${formatCount(comparison.changes.length)} comparable pairs are within the jitter threshold.`;
        parts.push(svgText(32, plotTop + 34, message, theme.muted, 13));
    } else {
        for (const [index, layout] of rowLayouts.entries()) {
            if (index % 2 === 0) parts.push(svgRect(32, layout.top, 1056, layout.height, 4, theme.surface, 'none'));
        }
        const jitterWidth = comparison.thresholdPercent * plotScale;
        parts.push(
            svgRect(
                zeroX - jitterWidth,
                plotTop,
                jitterWidth * 2,
                plotBottom - plotTop,
                0,
                theme.jitter,
                theme.jitterEdge,
            ),
        );
        for (const tickValue of [-axisMaximum, -axisMaximum / 2, 0, axisMaximum / 2, axisMaximum]) {
            const x = zeroX + tickValue * plotScale;
            const isZero = tickValue === 0;
            parts.push(
                `<line x1="${x}" y1="${plotTop}" x2="${x}" y2="${plotBottom}" stroke="${isZero ? theme.neutral : theme.grid}" stroke-width="${isZero ? 1.5 : 1}"/>`,
                svgText(x, timingHeadingTop + 50, formatAxisPercent(tickValue), theme.muted, 10, 400, 'mono', 'middle'),
            );
        }

        let previousStatus: BenchmarkChangeStatus | undefined;
        for (const layout of rowLayouts) {
            if (layout.change.status !== previousStatus) {
                previousStatus = layout.change.status;
                const groupName = previousStatus === 'regression' ? 'SLOWER' : 'FASTER';
                const groupColor = previousStatus === 'regression' ? theme.regression : theme.improvement;
                parts.push(svgText(32, layout.top - 8, groupName, groupColor, 10, 700));
            }

            const statusColor = layout.change.status === 'regression' ? theme.regression : theme.improvement;
            const centerY = layout.top + layout.height / 2;
            const barLength = Math.abs(layout.change.changePercent) * plotScale;
            const barX = layout.change.changePercent >= 0 ? zeroX : zeroX - barLength;
            const areaStartY = layout.top + 15;
            parts.push(
                svgTextLines(44, areaStartY, layout.areaLines, theme.foreground, 13, 650, 'ui', 15),
                svgTextLines(
                    44,
                    areaStartY + layout.areaLines.length * 15,
                    layout.engineLines,
                    theme.muted,
                    10.5,
                    500,
                    'mono',
                    12,
                ),
                svgTextLines(
                    44,
                    areaStartY + layout.areaLines.length * 15 + layout.engineLines.length * 12,
                    layout.contextLines,
                    theme.muted,
                    10,
                    400,
                    'ui',
                    12,
                ),
                svgRect(barX, centerY - 5, Math.max(barLength, 2), 10, 5, statusColor, 'none'),
                svgText(
                    changeColumnX,
                    centerY + 5,
                    formatSignedPercent(layout.change.changePercent),
                    statusColor,
                    12,
                    700,
                    'mono',
                ),
            );
        }
        parts.push(
            svgText(
                32,
                plotBottom + 24,
                `Amber band = ±${comparison.thresholdPercent}% jitter · full matrix report contains all workload comparisons and sample ranges`,
                theme.muted,
                10.5,
            ),
        );
    }

    parts.push('</svg>');
    return parts.join('');
}

function svgText(
    x: number,
    y: number,
    value: string,
    fill: string,
    size: number,
    weight = 400,
    font: SvgFont = 'ui',
    anchor: 'start' | 'middle' | 'end' = 'start',
): string {
    const family =
        font === 'mono'
            ? "ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', monospace"
            : "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    return `<text x="${x}" y="${y}" fill="${fill}" font-family="${family}" font-size="${size}px" font-weight="${weight}" text-anchor="${anchor}">${escapeXml(value)}</text>`;
}

function svgTextLines(
    x: number,
    y: number,
    values: string[],
    fill: string,
    size: number,
    weight: number,
    font: SvgFont,
    lineHeight: number,
): string {
    return values.map((value, index) => svgText(x, y + index * lineHeight, value, fill, size, weight, font)).join('');
}

function svgRect(
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number,
    fill: string,
    stroke: string,
): string {
    const border = stroke === 'none' ? '' : ` stroke="${stroke}" stroke-width="1"`;
    return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${fill}"${border}/>`;
}

function wrapWords(value: string, maximumCharacters: number): string[] {
    const words = value.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let line = '';
    for (const word of words) {
        if (word.length > maximumCharacters) {
            if (line) lines.push(line);
            line = '';
            for (let index = 0; index < word.length; index += maximumCharacters) {
                const part = word.slice(index, index + maximumCharacters);
                if (index + maximumCharacters < word.length) lines.push(part);
                else line = part;
            }
            continue;
        }
        const candidate = line ? `${line} ${word}` : word;
        if (candidate.length > maximumCharacters) {
            lines.push(line);
            line = word;
        } else {
            line = candidate;
        }
    }
    if (line) lines.push(line);
    return lines.length > 0 ? lines : [''];
}

function formatCount(value: number): string {
    return value.toLocaleString('en-US');
}

function formatInputsPerSample(value: number): string {
    return `${formatCount(value)} ${value === 1 ? 'input' : 'inputs'}/sample`;
}

function countLabel(value: number, singular: string, plural: string): string {
    return `${formatCount(value)} ${value === 1 ? singular : plural}`;
}

function formatMilliseconds(value: number): string {
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatAxisPercent(value: number): string {
    const magnitude = Math.round(Math.abs(value));
    if (value === 0) return '0%';
    return `${value < 0 ? '−' : '+'}${magnitude}%`;
}

function formatBytes(value: number): string {
    if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(2)} MiB`;
    if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`;
    return `${formatCount(value)} B`;
}

function sizeDelta(currentBytes: number, quickjsBytes: number | undefined, isQuickjs: boolean): string {
    if (isQuickjs) return 'QuickJS reference size';
    if (quickjsBytes === undefined || quickjsBytes === 0) return 'QuickJS size unavailable';
    const deltaBytes = currentBytes - quickjsBytes;
    const deltaPercent = (deltaBytes / quickjsBytes) * 100;
    const direction = deltaBytes < 0 ? '−' : deltaBytes > 0 ? '+' : '';
    return `${direction}${formatBytes(Math.abs(deltaBytes))} · ${formatSignedPercent(deltaPercent)} vs QuickJS`;
}

function escapeXml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&apos;');
}

function escapeHtmlAttribute(value: string): string {
    return escapeXml(value);
}

function appendChangeTable(lines: string[], heading: string, changes: BenchmarkChange[]): void {
    lines.push(
        `### ${heading}`,
        '',
        '| Engine | Workload | Baseline | Current | Change |',
        '| --- | --- | ---: | ---: | ---: |',
    );
    for (const change of changes.slice(0, 8)) {
        lines.push(
            `| ${escapeMarkdown(change.engineLabel)} | ${escapeMarkdown(change.workload)} | ${change.baselineMedianMs.toFixed(2)} ms | ${change.currentMedianMs.toFixed(2)} ms | ${formatSignedPercent(change.changePercent)} |`,
        );
    }
    if (changes.length > 8) lines.push(`| … | … | … | … | ${changes.length - 8} more changes |`);
    lines.push('');
}

function indexEngines(engines: readonly EngineResult[], revision: string): Map<string, EngineResult> {
    const indexed = new Map<string, EngineResult>();
    for (const engine of engines) {
        if (indexed.has(engine.id)) throw new Error(`${revision} results contain duplicate engine ${engine.id}`);
        indexed.set(engine.id, engine);
    }
    return indexed;
}

function indexWorkloads(engine: EngineResult): Map<string, BenchmarkWorkload> {
    const indexed = new Map<string, BenchmarkWorkload>();
    for (const workload of engine.workloads) {
        if (indexed.has(workload.name)) throw new Error(`${engine.label} contains duplicate workload ${workload.name}`);
        if (workload.samplesMs.length === 0) throw new Error(`${engine.label}/${workload.name} has no timing samples`);
        indexed.set(workload.name, workload);
    }
    return indexed;
}

function hasMatchingDefinition(current: BenchmarkWorkload, baseline: BenchmarkWorkload): boolean {
    return (
        current.area === baseline.area &&
        current.operationsPerSample === baseline.operationsPerSample &&
        current.provenance === baseline.provenance &&
        current.checksum === baseline.checksum
    );
}

function median(samples: number[]): number {
    const ordered = [...samples].sort((left, right) => left - right);
    return ordered[Math.floor(ordered.length / 2)] ?? 0;
}

function compareLargestFirst(left: BenchmarkChange, right: BenchmarkChange): number {
    return right.changePercent - left.changePercent;
}

function formatSignedPercent(value: number): string {
    return `${value > 0 ? '+' : value < 0 ? '−' : ''}${value.toFixed(1)}%`;
}

function shortSha(value: string): string {
    return value.slice(0, 7);
}

function escapeMarkdown(value: string): string {
    return value
        .replaceAll('\\', '\\\\')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('|', '\\|')
        .replaceAll('`', '\\`')
        .replaceAll('[', '\\[')
        .replaceAll(']', '\\]')
        .replaceAll('@', '@\u200b')
        .replaceAll('\n', ' ')
        .replaceAll('\r', ' ');
}
