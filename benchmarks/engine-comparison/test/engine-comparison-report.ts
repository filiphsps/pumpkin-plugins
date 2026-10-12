import type { BenchmarkWorkload, WorkloadProvenance } from '../src/benchmark-workloads.ts';

export interface EngineResult {
    id: string;
    label: string;
    binarySizeBytes: number;
    apiBehavior: {
        eventRegistrations: number;
        eventDispatches: number;
        scheduledTasks: number;
        scheduledCallbacks: number;
        permissionRegistrations: number;
        commandRegistrations: number;
        commandDispatches: number;
        serverQueries: number;
        playersObserved: number;
    };
    runtimeSourceCompilation: boolean;
    unicodePropertyEscapes: boolean;
    workloads: BenchmarkWorkload[];
}

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
            return `| ${escapeTableCell(engine.label)} | ${engine.binarySizeBytes.toLocaleString()} bytes | ${difference} |`;
        }),
        '',
        `| Benchmark type | Scope / workload | Inputs per sample | ${performanceColumns.join(' | ')} | ${ratioEngines.map(({ label }) => `${baseline.label}/${label}`).join(' | ')} |`,
        `| --- | --- | ---: | ${engines.map(() => '---:').join(' | ')} | ${ratioEngines.map(() => '---:').join(' | ')} |`
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
            .map(({ samplesMs }) => {
                const workloadMedian = median(samplesMs);
                return workloadMedian === 0 ? 'n/a' : `${(baselineMedian / workloadMedian).toFixed(2)}x`;
            });
        const type = provenanceLabel(baselineWorkload.provenance);
        const description = escapeTableCell(`${baselineWorkload.area} / ${baselineWorkload.name}`);
        lines.push(
            `| ${type} | ${description} | ${baselineWorkload.operationsPerSample.toLocaleString()} | ${timingCells.join(' | ')} | ${ratioCells.join(' | ')} |`
        );
    }

    const sampleCounts = [...new Set(baseline.workloads.map(({ samplesMs }) => samplesMs.length))].sort(
        (left, right) => left - right
    );
    const sampleDescription =
        sampleCounts.length === 1
            ? `${sampleCounts[0]} measured samples per workload`
            : `measured sample counts vary by workload (${sampleCounts.join(', ')})`;
    const syntheticCount = baseline.workloads.filter(
        ({ provenance }) => provenance === 'synthetic guest fixture'
    ).length;
    const realWorkloads = baseline.workloads.filter(({ provenance }) => provenance === 'real Pumpkin API');
    const behavior = Object.entries(baseline.apiBehavior)
        .map(([name, value]) => `${name}: ${value.toLocaleString()}`)
        .join(', ');
    const averageCells = engines.map((engine) => averageBenchmarkMedian(engine.workloads).toFixed(2));

    lines.push(
        '',
        `Each workload has one warm-up and ${sampleDescription}. Timings are informational and have no pass thresholds.`,
        ...(syntheticCount > 0
            ? [
                  'Synthetic rows use deterministic guest fixtures; they do not run the named plugins or Pumpkin’s host command router.'
              ]
            : []),
        ...(realWorkloads.length > 0
            ? [
                  `Real Pumpkin API workloads: ${realWorkloads.map(({ area, operationsPerSample }) => `${area} (${operationsPerSample.toLocaleString()} inputs per sample)`).join('; ')}.`,
                  'The comparison server has no connected players; player-oriented guest workloads use deterministic fixtures.'
              ]
            : []),
        `Pumpkin API behavior on ${baseline.label}: ${behavior}.`,
        ...engines
            .filter(({ runtimeSourceCompilation }) => !runtimeSourceCompilation)
            .map(
                ({ label }) =>
                    `${label} omits runtime source compilation, so \`eval\` and \`Function(string)\` are unavailable.`
            ),
        '',
        '### Average performance across all benchmarks',
        `Arithmetic mean of per-workload medians across ${baseline.workloads.length} performance benchmarks; component sizes are reported separately. A baseline/engine ratio above 1x means that engine took less time.`,
        '',
        `| Metric | ${engines.map(({ label }) => escapeTableCell(label)).join(' | ')} |`,
        `| --- | ${engines.map(() => '---:').join(' | ')} |`,
        `| Average benchmark median (ms) | ${averageCells.join(' | ')} |`
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
                `${engine.binarySizeBytes.toLocaleString()} bytes`,
                engine.id === baselineId
                    ? 'baseline'
                    : formatSizeDifference(engine.binarySizeBytes, baseline.binarySizeBytes)
            ])
        ),
        '',
        'Per-workload performance (median and min–max in ms; baseline/engine ratio above 1 means faster than baseline)'
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
            `${provenanceLabel(baselineWorkload.provenance)} | ${baselineWorkload.area} / ${baselineWorkload.name} | ${baselineWorkload.operationsPerSample.toLocaleString()} inputs/sample`,
            formatConsoleTable(['Engine', 'Median (ms)', 'Min–max (ms)', 'Baseline/engine'], workloadRows)
        );
    }

    const sampleCounts = [...new Set(baseline.workloads.map(({ samplesMs }) => samplesMs.length))].sort(
        (left, right) => left - right
    );
    const sampleDescription =
        sampleCounts.length === 1
            ? `${sampleCounts[0]} measured samples per workload`
            : `measured sample counts vary by workload (${sampleCounts.join(', ')})`;
    const syntheticCount = baseline.workloads.filter(
        ({ provenance }) => provenance === 'synthetic guest fixture'
    ).length;
    const realWorkloads = baseline.workloads.filter(({ provenance }) => provenance === 'real Pumpkin API');
    const behavior = Object.entries(baseline.apiBehavior)
        .map(([name, value]) => `${name}: ${value.toLocaleString()}`)
        .join(', ');
    const averageRows = [
        [
            'Average benchmark median (ms)',
            ...engines.map((engine) => averageBenchmarkMedian(engine.workloads).toFixed(2))
        ]
    ];

    lines.push(
        '',
        'Average performance across all benchmarks',
        formatConsoleTable(['Metric', ...engines.map(({ label }) => label)], averageRows),
        '',
        `Each workload has one warm-up and ${sampleDescription}. Timings are informational and have no pass thresholds.`,
        ...(syntheticCount > 0
            ? [
                  'Synthetic rows use deterministic guest fixtures; they do not run the named plugins or Pumpkin’s host command router.'
              ]
            : []),
        ...(realWorkloads.length > 0
            ? [
                  `Real Pumpkin API workloads: ${realWorkloads.map(({ area, operationsPerSample }) => `${area} (${operationsPerSample.toLocaleString()} inputs per sample)`).join('; ')}.`,
                  'The comparison server has no connected players; player-oriented guest workloads use deterministic fixtures.'
              ]
            : []),
        `Pumpkin API behavior on ${baseline.label}: ${behavior}.`,
        ...engines
            .filter(({ runtimeSourceCompilation }) => !runtimeSourceCompilation)
            .map(
                ({ label }) =>
                    `${label} omits runtime source compilation, so eval and Function(string) are unavailable.`
            )
    );

    return lines.join('\n');
}

function validateComparison(
    engines: readonly EngineResult[],
    baselineId: string
): { baseline: EngineResult; workloadMaps: Map<string, Map<string, BenchmarkWorkload>> } {
    const baseline = engines.find(({ id }) => id === baselineId);
    if (!baseline) throw new Error(`Unknown benchmark baseline: ${baselineId}`);
    if (engines.length < 2) throw new Error('Engine comparison requires at least two engines');
    if (new Set(engines.map(({ id }) => id)).size !== engines.length) {
        throw new Error('Engine comparison contains duplicate engine IDs');
    }

    const workloadMaps = new Map(engines.map((engine) => [engine.id, indexWorkloads(engine)]));
    const baselineNames = new Set(baseline.workloads.map(({ name }) => name));
    if (baselineNames.size !== baseline.workloads.length) {
        throw new Error(`${baseline.label} reports duplicate workload names`);
    }
    if (baselineNames.size === 0) throw new Error(`${baseline.label} reports no workloads`);

    for (const engine of engines) {
        const workloadMap = workloadMaps.get(engine.id);
        if (!workloadMap || workloadMap.size !== baselineNames.size) {
            throw new Error(`${engine.label} does not report the same workloads as ${baseline.label}`);
        }
        for (const name of baselineNames) {
            if (!workloadMap.has(name)) throw new Error(`${engine.label} is missing workload ${name}`);
        }
    }

    return { baseline, workloadMaps };
}

function indexWorkloads(engine: EngineResult): Map<string, BenchmarkWorkload> {
    const indexed = new Map<string, BenchmarkWorkload>();
    for (const workload of engine.workloads) {
        if (indexed.has(workload.name)) throw new Error(`${engine.label} reports duplicate workload ${workload.name}`);
        if (workload.samplesMs.length === 0)
            throw new Error(`${engine.label} workload ${workload.name} has no samples`);
        indexed.set(workload.name, workload);
    }
    return indexed;
}

function provenanceLabel(provenance: WorkloadProvenance): string {
    return provenance === 'real Pumpkin API' ? 'real' : 'synthetic';
}

function formatSizeDifference(sizeBytes: number, baselineBytes: number): string {
    const differenceBytes = sizeBytes - baselineBytes;
    const differencePercent = (100 * differenceBytes) / baselineBytes;
    const signedBytes = `${differenceBytes > 0 ? '+' : ''}${differenceBytes.toLocaleString()}`;
    const signedPercent = `${differencePercent > 0 ? '+' : ''}${differencePercent.toFixed(2)}`;
    return `${signedBytes} bytes (${signedPercent}%)`;
}

function averageBenchmarkMedian(workloads: BenchmarkWorkload[]): number {
    return workloads.reduce((total, workload) => total + median(workload.samplesMs), 0) / workloads.length;
}

function median(samples: number[]): number {
    const ordered = [...samples].sort((left, right) => left - right);
    return ordered[Math.floor(ordered.length / 2)];
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
