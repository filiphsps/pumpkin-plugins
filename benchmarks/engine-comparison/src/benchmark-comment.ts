import {
    type BenchmarkChange,
    type BenchmarkComparison,
    formatSignedPercent,
    MINIMUM_CHANGE_MS,
} from './benchmark-regression.ts';
import { escapeXml } from './svg.ts';

/** Inputs used to write a repeatable pull request comment for one benchmark run. */
export interface BenchmarkCommentDetails {
    baselineSha?: string;
    chartUrls?: { dark: string; light: string };
    comparison?: BenchmarkComparison;
    currentSha: string;
    noBaselineReason?: string;
    reportRunUrl: string;
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
            `Changes within ±${comparison.thresholdPercent}% or under ${MINIMUM_CHANGE_MS} ms are treated as runner jitter. Lower time is better. ${direction}`,
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
        const lightUrl = escapeXml(details.chartUrls.light);
        const darkUrl = escapeXml(details.chartUrls.dark);
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
    }
    return lines.join('\n');
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
