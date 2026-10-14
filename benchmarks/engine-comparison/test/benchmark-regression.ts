import * as vega from 'vega';
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
    status: BenchmarkChangeStatus;
    workload: string;
}

/** Per-workload timing changes grouped by their effect size. */
export interface BenchmarkComparison {
    changes: BenchmarkChange[];
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
    chartRunUrl?: string;
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
                status:
                    changePercent > thresholdPercent
                        ? 'regression'
                        : changePercent < -thresholdPercent
                          ? 'improvement'
                          : 'within-jitter',
                workload: workload.name,
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
    if (details.chartRunUrl) lines.push(`[Download the SVG comparison chart](${details.chartRunUrl}).`);
    return lines.join('\n');
}

/**
 * Renders a compact Vega SVG bar chart of the largest timing changes for the workflow artifact.
 *
 * @param comparison - Timing changes and jitter classification from a matrix comparison.
 * @returns Standalone SVG source suitable for an Actions artifact.
 */
export async function formatBenchmarkChangeSvg(comparison: BenchmarkComparison): Promise<string> {
    const changes = [...comparison.changes]
        .sort((left, right) => Math.abs(right.changePercent) - Math.abs(left.changePercent))
        .slice(0, 24);
    const values =
        changes.length > 0
            ? changes.map(({ changePercent, engineLabel, status, workload }) => ({
                  changePercent,
                  end: Math.max(0, changePercent),
                  formatted: formatSignedPercent(changePercent),
                  label: truncate(`${workload} · ${engineLabel}`, 42),
                  start: Math.min(0, changePercent),
                  status,
              }))
            : [
                  {
                      changePercent: 0,
                      end: 0,
                      formatted: '',
                      label: 'No comparable workload timings',
                      start: 0,
                      status: 'within-jitter',
                  },
              ];
    const maximum = Math.ceil(Math.max(25, ...changes.map(({ changePercent }) => Math.abs(changePercent))) * 1.1);
    const spec: vega.Spec = {
        $schema: 'https://vega.github.io/schema/vega/v5.json',
        background: '#ffffff',
        width: 640,
        height: Math.max(80, values.length * 26),
        padding: { left: 8, right: 32, top: 78, bottom: 56 },
        title: {
            text: 'Benchmark timing changes',
            subtitle: `Compared with baseline; lower time is better. Jitter threshold: ±${comparison.thresholdPercent}%.`,
            anchor: 'start',
            font: 'Arial',
            fontSize: 20,
            color: '#24292f',
            subtitleFont: 'Arial',
            subtitleFontSize: 12,
            subtitleColor: '#57606a',
        },
        data: [{ name: 'changes', values }],
        scales: [
            { name: 'x', type: 'linear', domain: [-maximum, maximum], range: 'width', nice: false },
            { name: 'y', type: 'band', domain: { data: 'changes', field: 'label' }, range: 'height', padding: 0.2 },
            {
                name: 'status',
                type: 'ordinal',
                domain: ['regression', 'improvement', 'within-jitter'],
                range: ['#cf222e', '#1a7f37', '#8c959f'],
            },
        ],
        axes: [
            {
                orient: 'bottom',
                scale: 'x',
                grid: true,
                title: 'Change from baseline (%)',
                format: '+d',
                gridColor: '#d8dee4',
                domainColor: '#8c959f',
                tickColor: '#8c959f',
                labelFont: 'Arial',
                labelFontSize: 11,
                titleFont: 'Arial',
                titleFontSize: 12,
            },
            {
                orient: 'left',
                scale: 'y',
                domain: false,
                ticks: false,
                labelFont: 'Arial',
                labelFontSize: 11,
                labelLimit: 280,
            },
        ],
        marks: [
            {
                type: 'rect',
                encode: {
                    update: {
                        x: { scale: 'x', value: -comparison.thresholdPercent },
                        x2: { scale: 'x', value: comparison.thresholdPercent },
                        y: { value: 0 },
                        y2: { signal: 'height' },
                        fill: { value: '#fff8c5' },
                        fillOpacity: { value: 0.85 },
                    },
                },
            },
            {
                type: 'rect',
                from: { data: 'changes' },
                encode: {
                    update: {
                        x: { scale: 'x', field: 'start' },
                        x2: { scale: 'x', field: 'end' },
                        y: { scale: 'y', field: 'label', offset: 4 },
                        height: { scale: 'y', band: 0.7 },
                        fill: { scale: 'status', field: 'status' },
                        cornerRadius: { value: 3 },
                    },
                },
            },
            {
                type: 'rule',
                encode: {
                    update: {
                        x: { scale: 'x', value: 0 },
                        y: { value: 0 },
                        y2: { signal: 'height' },
                        stroke: { value: '#57606a' },
                        strokeWidth: { value: 1 },
                    },
                },
            },
            {
                type: 'text',
                from: { data: 'changes' },
                encode: {
                    update: {
                        x: {
                            signal: 'scale("x", datum.changePercent) + (datum.changePercent >= 0 ? 8 : -8)',
                        },
                        y: { scale: 'y', field: 'label', band: 0.5 },
                        text: { field: 'formatted' },
                        align: { signal: "datum.changePercent >= 0 ? 'left' : 'right'" },
                        baseline: { value: 'middle' },
                        fill: { value: '#24292f' },
                        font: { value: 'Arial' },
                        fontSize: { value: 11 },
                    },
                },
            },
        ],
    };
    const view = new vega.View(vega.parse(spec), { renderer: 'none' });
    try {
        return await view.toSVG();
    } finally {
        view.finalize();
    }
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
    return `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
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

function truncate(value: string, maximumLength: number): string {
    return value.length > maximumLength ? `${value.slice(0, maximumLength - 1)}…` : value;
}
