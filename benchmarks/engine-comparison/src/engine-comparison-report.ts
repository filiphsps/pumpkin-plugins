import {
    type EngineResult,
    formatInteger,
    indexWorkloads,
    median,
    validateMatchingResults,
} from './benchmark-results.ts';
import type { BenchmarkWorkload, WorkloadProvenance } from './benchmark-workloads.ts';

/** Formats size and performance results for an arbitrary set of matching engines. */
export function formatReport(engines: readonly EngineResult[], baselineId: string): string {
    const { baseline, workloadMaps } = validateComparison(engines, baselineId);

    const performanceColumns = engines.map(({ label }) => `${label} median (min–max)`);
    const ratioEngines = engines.filter(({ id }) => id !== baselineId);
    const lines = [
        '### Runtime engine comparison',
        '',
        `| Engine | Production component size | Difference from ${baseline.label} |`,
        '| --- | ---: | ---: |',
        ...engines.map((engine) => {
            const difference =
                engine.id === baselineId
                    ? 'baseline'
                    : formatSizeDifference(engine.binarySizeBytes, baseline.binarySizeBytes);
            return `| ${escapeTableCell(engine.label)} | ${formatInteger(engine.binarySizeBytes)} bytes | ${difference} |`;
        }),
        '',
        `| Benchmark type | Scope / workload | Inputs per sample | ${performanceColumns.join(' | ')} | ${ratioEngines.map(({ label }) => `${baseline.label}/${label}`).join(' | ')} |`,
        `| --- | --- | ---: | ${engines.map(() => '---:').join(' | ')} | ${ratioEngines.map(() => '---:').join(' | ')} |`,
    ];

    for (const baselineWorkload of baseline.workloads) {
        const matchingWorkloads = engines.map((engine) => {
            const workload = workloadMaps.get(engine.id)?.get(baselineWorkload.name);
            if (!workload) throw new Error(`${engine.label} is missing workload ${baselineWorkload.name}`);
            return workload;
        });
        const baselineMedian = median(baselineWorkload.samplesMs);
        const timingCells = matchingWorkloads.map(({ samplesMs }) => sampleSummary(samplesMs));
        const ratioCells = matchingWorkloads
            .filter((_, index) => engines[index]?.id !== baselineId)
            .map(({ samplesMs }) => formatRatio(baselineMedian, median(samplesMs)));
        const type = provenanceLabel(baselineWorkload.provenance);
        const description = escapeTableCell(`${baselineWorkload.area} / ${baselineWorkload.name}`);
        lines.push(
            `| ${type} | ${description} | ${formatInteger(baselineWorkload.operationsPerSample)} | ${timingCells.join(' | ')} | ${ratioCells.join(' | ')} |`,
        );
    }

    const averageCells = engines.map((engine) => averageBenchmarkMedian(engine.workloads).toFixed(2));

    lines.push(
        '',
        ...reportNotes(engines, baseline, (text) => `\`${text}\``),
        '',
        '### Average performance across all benchmarks',
        `Arithmetic mean of per-workload medians across ${baseline.workloads.length} performance benchmarks; component sizes are reported separately. A baseline/engine ratio above 1x means that engine took less time.`,
        '',
        `| Metric | ${engines.map(({ label }) => escapeTableCell(label)).join(' | ')} |`,
        `| --- | ${engines.map(() => '---:').join(' | ')} |`,
        `| Average benchmark median (ms) | ${averageCells.join(' | ')} |`,
    );

    return lines.join('\n');
}

/** Formats the same comparison as compact aligned tables for terminal output. */
export function formatConsoleReport(engines: readonly EngineResult[], baselineId: string): string {
    const { baseline, workloadMaps } = validateComparison(engines, baselineId);
    const lines = [
        'Runtime engine comparison',
        '',
        `Component sizes (baseline: ${baseline.label})`,
        formatConsoleTable(
            ['Engine', 'Component size', 'Difference from baseline'],
            engines.map((engine) => [
                engine.label,
                `${formatInteger(engine.binarySizeBytes)} bytes`,
                engine.id === baselineId
                    ? 'baseline'
                    : formatSizeDifference(engine.binarySizeBytes, baseline.binarySizeBytes),
            ]),
        ),
        '',
        'Per-workload performance (median and min–max in ms; baseline/engine ratio above 1 means faster than baseline)',
    ];

    for (const baselineWorkload of baseline.workloads) {
        const baselineMedian = median(baselineWorkload.samplesMs);
        const workloadRows = engines.map((engine) => {
            const workload = workloadMaps.get(engine.id)?.get(baselineWorkload.name);
            if (!workload) throw new Error(`${engine.label} is missing workload ${baselineWorkload.name}`);
            const workloadMedian = median(workload.samplesMs);
            const ratio = engine.id === baselineId ? 'baseline' : formatRatio(baselineMedian, workloadMedian);
            return [engine.label, workloadMedian.toFixed(2), sampleRange(workload.samplesMs), ratio];
        });
        lines.push(
            '',
            `${provenanceLabel(baselineWorkload.provenance)} | ${baselineWorkload.area} / ${baselineWorkload.name} | ${formatInteger(baselineWorkload.operationsPerSample)} inputs/sample`,
            formatConsoleTable(['Engine', 'Median (ms)', 'Min–max (ms)', 'Baseline/engine'], workloadRows),
        );
    }

    const averageRows = [
        [
            'Average benchmark median (ms)',
            ...engines.map((engine) => averageBenchmarkMedian(engine.workloads).toFixed(2)),
        ],
    ];

    lines.push(
        '',
        'Average performance across all benchmarks',
        formatConsoleTable(['Metric', ...engines.map(({ label }) => label)], averageRows),
        '',
        ...reportNotes(engines, baseline, (text) => text),
    );

    return lines.join('\n');
}

function validateComparison(
    engines: readonly EngineResult[],
    baselineId: string,
): { baseline: EngineResult; workloadMaps: Map<string, Map<string, BenchmarkWorkload>> } {
    const baseline = engines.find(({ id }) => id === baselineId);
    if (!baseline) throw new Error(`Unknown benchmark baseline: ${baselineId}`);
    if (engines.length < 2) throw new Error('Engine comparison requires at least two engines');
    validateMatchingResults(engines, baseline);
    return { baseline, workloadMaps: new Map(engines.map((engine) => [engine.id, indexWorkloads(engine)])) };
}

function reportNotes(
    engines: readonly EngineResult[],
    baseline: EngineResult,
    code: (text: string) => string,
): string[] {
    const sampleCounts = [...new Set(baseline.workloads.map(({ samplesMs }) => samplesMs.length))].sort(
        (left, right) => left - right,
    );
    const sampleDescription =
        sampleCounts.length === 1
            ? `${sampleCounts[0]} measured samples per workload`
            : `measured sample counts vary by workload (${sampleCounts.join(', ')})`;
    const hasSynthetic = baseline.workloads.some(({ provenance }) => provenance === 'synthetic guest fixture');
    const realWorkloads = baseline.workloads.filter(({ provenance }) => provenance === 'real Pumpkin API');
    const behavior = Object.entries(baseline.apiBehavior)
        .map(([name, value]) => `${name}: ${formatInteger(value)}`)
        .join(', ');

    return [
        `Each workload has one warm-up and ${sampleDescription}. Timings are informational and have no pass thresholds.`,
        ...(hasSynthetic
            ? [
                  'Synthetic rows use deterministic guest fixtures; they do not run the named plugins or Pumpkin’s host command router.',
              ]
            : []),
        ...(realWorkloads.length > 0
            ? [
                  `Real Pumpkin API workloads: ${realWorkloads.map(({ area, operationsPerSample }) => `${area} (${formatInteger(operationsPerSample)} inputs per sample)`).join('; ')}.`,
                  'The comparison server has no connected players; player-oriented guest workloads use deterministic fixtures.',
              ]
            : []),
        `Pumpkin API behavior on ${baseline.label}: ${behavior}.`,
        ...engines
            .filter(({ runtimeSourceCompilation }) => !runtimeSourceCompilation)
            .map(
                ({ label }) =>
                    `${label} omits runtime source compilation, so ${code('eval')} and ${code('Function(string)')} are unavailable.`,
            ),
    ];
}

function provenanceLabel(provenance: WorkloadProvenance): string {
    return provenance === 'real Pumpkin API' ? 'real' : 'synthetic';
}

function formatSizeDifference(sizeBytes: number, baselineBytes: number): string {
    const differenceBytes = sizeBytes - baselineBytes;
    const differencePercent = (100 * differenceBytes) / baselineBytes;
    const signedBytes = `${differenceBytes > 0 ? '+' : ''}${formatInteger(differenceBytes)}`;
    const signedPercent = `${differencePercent > 0 ? '+' : ''}${differencePercent.toFixed(2)}`;
    return `${signedBytes} bytes (${signedPercent}%)`;
}

function averageBenchmarkMedian(workloads: BenchmarkWorkload[]): number {
    return workloads.reduce((total, workload) => total + median(workload.samplesMs), 0) / workloads.length;
}

function sampleSummary(samples: number[]): string {
    const minimum = Math.min(...samples).toFixed(2);
    const maximum = Math.max(...samples).toFixed(2);
    return `${median(samples).toFixed(2)} ms (${minimum}–${maximum} ms)`;
}

function sampleRange(samples: number[]): string {
    const minimum = Math.min(...samples).toFixed(2);
    const maximum = Math.max(...samples).toFixed(2);
    return `${minimum}–${maximum}`;
}

function formatRatio(baselineMedian: number, workloadMedian: number): string {
    return workloadMedian === 0 ? 'n/a' : `${(baselineMedian / workloadMedian).toFixed(2)}x`;
}

function formatConsoleTable(headers: string[], rows: string[][]): string {
    if (rows.some((row) => row.length !== headers.length)) {
        throw new Error('Console table rows must match the header column count');
    }
    const values = [headers, ...rows].map((row) => row.map((cell) => cell.replaceAll('\n', ' ')));
    const widths = headers.map((_, index) => Math.max(...values.map((row) => row[index]?.length ?? 0)));
    const border = `+${widths.map((width) => '-'.repeat(width + 2)).join('+')}+`;
    const formatRow = (row: string[]) => `| ${row.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join(' | ')} |`;
    return [border, formatRow(values[0] ?? []), border, ...values.slice(1).map(formatRow), border].join('\n');
}

function escapeTableCell(value: string): string {
    return value.replaceAll('|', '\\|').replaceAll('\n', '<br>');
}
