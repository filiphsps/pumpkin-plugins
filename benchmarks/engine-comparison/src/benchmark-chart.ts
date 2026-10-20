import {
    type BenchmarkChange,
    type BenchmarkChangeStatus,
    type BenchmarkComparison,
    formatSignedPercent,
} from './benchmark-regression.ts';
import { formatInteger } from './benchmark-results.ts';
import { svgRect, svgText, svgTextLines, wrapWords } from './svg.ts';

const SVG_WIDTH = 1120;
const MAX_CHANGES_PER_DIRECTION = 12;
const SIZE_SECTION_TOP = 184;
const SIZE_CARDS_TOP = SIZE_SECTION_TOP + 24;
const SIZE_CARD = { columns: 3, width: 344, height: 62, gap: 10 } as const;
const PLOT_X = 480;
const PLOT_WIDTH = 520;
const ZERO_X = PLOT_X + PLOT_WIDTH / 2;
const CHANGE_COLUMN_X = 1012;
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
type SvgTheme = (typeof SVG_THEMES)[SvgThemeName];

/** One visible timing change with its wrapped text and vertical position. */
interface ChangeRow {
    areaLines: string[];
    change: BenchmarkChange;
    contextLines: string[];
    engineLines: string[];
    height: number;
    top: number;
}

/** Positions that depend on the comparison: the timing rows, the plot area and the chart height. */
interface ChartLayout {
    /** Percentage at each end of the change axis. */
    axisMaximum: number;
    height: number;
    plotBottom: number;
    /** Pixels per percentage point of change. */
    plotScale: number;
    plotTop: number;
    /** Regressions, then improvements, each capped at {@link MAX_CHANGES_PER_DIRECTION}. */
    rows: ChangeRow[];
    timingHeadingTop: number;
}

/** Renders light- and dark-theme SVG charts from the same benchmark comparison. */
export function formatBenchmarkChangeSvgs(comparison: BenchmarkComparison): { dark: string; light: string } {
    return {
        dark: renderBenchmarkSvg(comparison, 'dark'),
        light: renderBenchmarkSvg(comparison, 'light'),
    };
}

function renderBenchmarkSvg(comparison: BenchmarkComparison, themeName: SvgThemeName): string {
    const theme = SVG_THEMES[themeName];
    const layout = layoutChart(comparison);
    return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_WIDTH}" height="${layout.height}" viewBox="0 0 ${SVG_WIDTH} ${layout.height}" role="img" aria-labelledby="chart-title chart-description">`,
        `<title id="chart-title">Runtime benchmark changes, ${themeName} theme</title>`,
        '<desc id="chart-description">Benchmark timing medians, engine component sizes, and workload changes outside the jitter threshold.</desc>',
        `<rect width="${SVG_WIDTH}" height="${layout.height}" fill="${theme.background}"/>`,
        svgText(32, 42, 'Runtime benchmark changes', theme.foreground, 25, 700),
        svgText(
            32,
            66,
            `Lower time is better · bars show median change · jitter threshold ±${comparison.thresholdPercent}%`,
            theme.muted,
            13,
        ),
        ...drawSummaryCards(comparison, theme),
        ...drawEngineSizes(comparison, theme),
        ...drawTimingHeading(comparison, theme, layout.timingHeadingTop),
        ...drawTimingChanges(comparison, theme, layout),
        '</svg>',
    ].join('');
}

function layoutChart(comparison: BenchmarkComparison): ChartLayout {
    const sizeRows = Math.ceil(comparison.engineSizes.length / SIZE_CARD.columns);
    const sizeSectionBottom = SIZE_CARDS_TOP + sizeRows * (SIZE_CARD.height + SIZE_CARD.gap);
    const timingHeadingTop = Math.max(sizeSectionBottom + 20, SIZE_CARDS_TOP + 16);
    const rows: ChangeRow[] = [];
    let cursorY = timingHeadingTop + 62;
    for (const changes of [comparison.regressions, comparison.improvements]) {
        if (changes.length === 0) continue;
        cursorY += 22;
        for (const change of changes.slice(0, MAX_CHANGES_PER_DIRECTION)) {
            const row = layoutChangeRow(change, cursorY);
            rows.push(row);
            cursorY += row.height;
        }
    }

    const maximumChange = Math.max(
        25,
        comparison.thresholdPercent * 1.5,
        ...rows.map(({ change }) => Math.abs(change.changePercent)),
    );
    const axisMaximum = Math.ceil(maximumChange * 1.08);
    const plotTop = timingHeadingTop + 64;
    const plotBottom = Math.max(plotTop + 62, cursorY + 2);
    return {
        rows,
        timingHeadingTop,
        plotTop,
        plotBottom,
        height: plotBottom + 58,
        axisMaximum,
        plotScale: PLOT_WIDTH / 2 / axisMaximum,
    };
}

function layoutChangeRow(change: BenchmarkChange, top: number): ChangeRow {
    const areaLines = wrapWords(change.workloadArea, 48);
    const engineLines = wrapWords(`${change.workload} · ${change.engineLabel}`, 72);
    const contextLines = wrapWords(
        `${change.workloadProvenance} · ${formatInputsPerSample(change.operationsPerSample)} · median ${formatMilliseconds(change.baselineMedianMs)} → ${formatMilliseconds(change.currentMedianMs)} ms`,
        72,
    );
    const contentHeight = areaLines.length * 15 + engineLines.length * 12 + contextLines.length * 12;
    return { change, top, height: Math.max(46, contentHeight + 6), areaLines, engineLines, contextLines };
}

function drawSummaryCards(comparison: BenchmarkComparison, theme: SvgTheme): string[] {
    const withinJitterCount = comparison.changes.filter(({ status }) => status === 'within-jitter').length;
    const medianChange =
        comparison.medianChangePercent === null ? 'n/a' : formatSignedPercent(comparison.medianChangePercent);
    const cards = [
        { label: 'PAIRS', value: formatInteger(comparison.changes.length), color: theme.foreground },
        { label: 'REGRESSIONS', value: formatInteger(comparison.regressions.length), color: theme.regression },
        { label: 'IMPROVEMENTS', value: formatInteger(comparison.improvements.length), color: theme.improvement },
        { label: 'WITHIN JITTER', value: formatInteger(withinJitterCount), color: theme.jitterEdge },
        { label: 'MEDIAN CHANGE', value: medianChange, color: theme.foreground },
        { label: 'SKIPPED', value: formatInteger(comparison.skippedWorkloads.length), color: theme.muted },
    ];
    const top = 82;
    const width = 168;
    const height = 70;
    const gap = 8;
    return cards.flatMap((card, index) => {
        const x = 32 + index * (width + gap);
        return [
            svgRect(x, top, width, height, 8, theme.surface, theme.rule),
            svgText(x + 12, top + 24, card.label, theme.muted, 10, 700),
            svgText(x + 12, top + 52, card.value, card.color, 21, 700, 'mono'),
        ];
    });
}

function drawEngineSizes(comparison: BenchmarkComparison, theme: SvgTheme): string[] {
    const parts = [
        svgText(32, SIZE_SECTION_TOP, 'COMPONENT SIZE BY ENGINE', theme.foreground, 12, 700),
        svgText(1088, SIZE_SECTION_TOP, 'Current build · change vs QuickJS', theme.muted, 11, 400, 'ui', 'end'),
    ];
    if (comparison.engineSizes.length === 0) {
        parts.push(svgText(32, SIZE_CARDS_TOP + 20, 'Component size data unavailable', theme.muted, 12));
    }
    const quickjsSize = comparison.engineSizes.find(({ engineId }) => engineId === 'quickjs')?.binarySizeBytes;
    for (const [index, engine] of comparison.engineSizes.entries()) {
        const x = 32 + (index % SIZE_CARD.columns) * (SIZE_CARD.width + SIZE_CARD.gap);
        const y = SIZE_CARDS_TOP + Math.floor(index / SIZE_CARD.columns) * (SIZE_CARD.height + SIZE_CARD.gap);
        const delta = sizeDelta(engine.binarySizeBytes, quickjsSize, engine.engineId === 'quickjs');
        parts.push(
            svgRect(x, y, SIZE_CARD.width, SIZE_CARD.height, 8, theme.surface, theme.rule),
            svgText(x + 12, y + 21, engine.engineLabel, theme.foreground, 12, 600),
            svgText(x + 12, y + 45, delta, theme.muted, 10.5, 400),
            svgText(
                x + SIZE_CARD.width - 12,
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
    return parts;
}

function drawTimingHeading(comparison: BenchmarkComparison, theme: SvgTheme, top: number): string[] {
    const regressionCount = comparison.regressions.length;
    const improvementCount = comparison.improvements.length;
    const displayNote = [
        regressionCount > MAX_CHANGES_PER_DIRECTION
            ? `top ${MAX_CHANGES_PER_DIRECTION} of ${regressionCount} regressions`
            : countLabel(regressionCount, 'regression', 'regressions'),
        improvementCount > MAX_CHANGES_PER_DIRECTION
            ? `top ${MAX_CHANGES_PER_DIRECTION} of ${improvementCount} improvements`
            : countLabel(improvementCount, 'improvement', 'improvements'),
    ].join(' · ');
    return [
        svgText(32, top, 'TIMING CHANGES OUTSIDE JITTER', theme.foreground, 12, 700),
        svgText(1088, top, displayNote, theme.muted, 10.5, 400, 'ui', 'end'),
        svgText(
            32,
            top + 21,
            'Workload and engine context · baseline → current median · lower is better',
            theme.muted,
            11,
        ),
        svgText(CHANGE_COLUMN_X, top + 38, 'CHANGE', theme.muted, 10, 700, 'ui', 'start'),
    ];
}

function drawTimingChanges(comparison: BenchmarkComparison, theme: SvgTheme, layout: ChartLayout): string[] {
    if (layout.rows.length === 0) {
        const message =
            comparison.changes.length === 0
                ? 'No comparable workload timings in this run.'
                : `All ${formatInteger(comparison.changes.length)} comparable pairs are within the jitter threshold.`;
        return [svgText(32, layout.plotTop + 34, message, theme.muted, 13)];
    }

    return [
        ...layout.rows
            .filter((_, index) => index % 2 === 0)
            .map(({ top, height }) => svgRect(32, top, 1056, height, 4, theme.surface, 'none')),
        ...drawPlotGrid(comparison, theme, layout),
        ...drawChangeRows(theme, layout),
        svgText(
            32,
            layout.plotBottom + 24,
            `Amber band = ±${comparison.thresholdPercent}% jitter · full matrix report contains all workload comparisons and sample ranges`,
            theme.muted,
            10.5,
        ),
    ];
}

function drawPlotGrid(comparison: BenchmarkComparison, theme: SvgTheme, layout: ChartLayout): string[] {
    const { axisMaximum, plotBottom, plotScale, plotTop, timingHeadingTop } = layout;
    const jitterWidth = comparison.thresholdPercent * plotScale;
    const parts = [
        svgRect(
            ZERO_X - jitterWidth,
            plotTop,
            jitterWidth * 2,
            plotBottom - plotTop,
            0,
            theme.jitter,
            theme.jitterEdge,
        ),
    ];
    for (const tickValue of [-axisMaximum, -axisMaximum / 2, 0, axisMaximum / 2, axisMaximum]) {
        const x = ZERO_X + tickValue * plotScale;
        const isZero = tickValue === 0;
        parts.push(
            `<line x1="${x}" y1="${plotTop}" x2="${x}" y2="${plotBottom}" stroke="${isZero ? theme.neutral : theme.grid}" stroke-width="${isZero ? 1.5 : 1}"/>`,
            svgText(x, timingHeadingTop + 50, formatAxisPercent(tickValue), theme.muted, 10, 400, 'mono', 'middle'),
        );
    }
    return parts;
}

function drawChangeRows(theme: SvgTheme, layout: ChartLayout): string[] {
    const parts: string[] = [];
    let previousStatus: BenchmarkChangeStatus | undefined;
    for (const row of layout.rows) {
        if (row.change.status !== previousStatus) {
            previousStatus = row.change.status;
            const groupName = previousStatus === 'regression' ? 'SLOWER' : 'FASTER';
            const groupColor = previousStatus === 'regression' ? theme.regression : theme.improvement;
            parts.push(svgText(32, row.top - 8, groupName, groupColor, 10, 700));
        }
        parts.push(...drawChangeRow(theme, row, layout.plotScale));
    }
    return parts;
}

function drawChangeRow(theme: SvgTheme, row: ChangeRow, plotScale: number): string[] {
    const { change, top, height, areaLines, engineLines, contextLines } = row;
    const statusColor = change.status === 'regression' ? theme.regression : theme.improvement;
    const centerY = top + height / 2;
    const barLength = Math.abs(change.changePercent) * plotScale;
    const barX = change.changePercent >= 0 ? ZERO_X : ZERO_X - barLength;
    const areaStartY = top + 15;
    const engineStartY = areaStartY + areaLines.length * 15;
    const contextStartY = engineStartY + engineLines.length * 12;
    return [
        svgTextLines(44, areaStartY, areaLines, theme.foreground, 13, 650, 'ui', 15),
        svgTextLines(44, engineStartY, engineLines, theme.muted, 10.5, 500, 'mono', 12),
        svgTextLines(44, contextStartY, contextLines, theme.muted, 10, 400, 'ui', 12),
        svgRect(barX, centerY - 5, Math.max(barLength, 2), 10, 5, statusColor, 'none'),
        svgText(CHANGE_COLUMN_X, centerY + 5, formatSignedPercent(change.changePercent), statusColor, 12, 700, 'mono'),
    ];
}

function formatInputsPerSample(value: number): string {
    return `${formatInteger(value)} ${value === 1 ? 'input' : 'inputs'}/sample`;
}

function countLabel(value: number, singular: string, plural: string): string {
    return `${formatInteger(value)} ${value === 1 ? singular : plural}`;
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
    return `${formatInteger(value)} B`;
}

function sizeDelta(currentBytes: number, quickjsBytes: number | undefined, isQuickjs: boolean): string {
    if (isQuickjs) return 'QuickJS reference size';
    if (quickjsBytes === undefined || quickjsBytes === 0) return 'QuickJS size unavailable';
    const deltaBytes = currentBytes - quickjsBytes;
    const deltaPercent = (deltaBytes / quickjsBytes) * 100;
    const direction = deltaBytes < 0 ? '−' : deltaBytes > 0 ? '+' : '';
    return `${direction}${formatBytes(Math.abs(deltaBytes))} · ${formatSignedPercent(deltaPercent)} vs QuickJS`;
}
