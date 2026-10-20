import { expect, it } from 'vitest';
import { engine, workload } from '../test/benchmark-fixtures.ts';
import { formatBenchmarkComment } from './benchmark-comment.ts';
import { compareBenchmarkResults } from './benchmark-regression.ts';

it('shows warning, celebration, and regular outcomes in the PR comment', () => {
    const outcomes = [
        { currentMs: 125, heading: /regression/i, workload: 'slower' },
        { currentMs: 75, heading: /improvement/i, workload: 'faster' },
        { currentMs: 105, heading: /benchmark results/i },
    ];

    for (const outcome of outcomes) {
        const workloadName = outcome.workload ?? 'unchanged';
        const comparison = compareBenchmarkResults(
            [engine('quickjs', [workload(workloadName, [outcome.currentMs])])],
            [engine('quickjs', [workload(workloadName, [100])])],
        );
        const comment = formatBenchmarkComment({
            comparison,
            baselineSha: '1234567890abcdef',
            currentSha: 'abcdef1234567890',
            reportRunUrl: 'https://github.com/example/repo/actions/runs/123',
        });

        expect(comment.split('\n')[0]).toMatch(outcome.heading);
        if (outcome.workload) {
            expect(comment).toContain(outcome.workload);
        } else {
            expect(comment).toMatch(/no workload changed beyond.*jitter threshold/i);
        }
    }
});

it('selects the light and dark SVG variants by GitHub color scheme', () => {
    const lightUrl = 'https://example.com/benchmark-light.svg';
    const darkUrl = 'https://example.com/benchmark-dark.svg';
    const comment = formatBenchmarkComment({
        chartUrls: { dark: darkUrl, light: lightUrl },
        comparison: compareBenchmarkResults(
            [engine('quickjs', [workload('slower', [125])])],
            [engine('quickjs', [workload('slower', [100])])],
        ),
        baselineSha: '1234567890abcdef',
        currentSha: 'abcdef1234567890',
        reportRunUrl: 'https://github.com/example/repo/actions/runs/123',
    });

    expect(comment).toContain(`media="(prefers-color-scheme: dark)" type="image/svg+xml" srcset="${darkUrl}"`);
    expect(comment).toContain(`media="(prefers-color-scheme: light)" type="image/svg+xml" srcset="${lightUrl}"`);
    expect(comment).toContain(`[Download light SVG](${lightUrl})`);
    expect(comment).toContain(`[Download dark SVG](${darkUrl})`);
});

it('escapes benchmark labels in the repeatable PR comment', () => {
    const comment = formatBenchmarkComment({
        comparison: compareBenchmarkResults(
            [engine('quickjs', [workload('@reviewer <script>', [80])])],
            [engine('quickjs', [workload('@reviewer <script>', [100])])],
            10,
        ),
        baselineSha: '1234567890abcdef',
        currentSha: 'abcdef1234567890',
        reportRunUrl: 'https://github.com/example/repo/actions/runs/123',
    });

    expect(comment.split('\n')[0]).toMatch(/improvement/i);
    expect(comment).toContain('@​reviewer &lt;script&gt;');
    expect(comment).toContain('https://github.com/example/repo/actions/runs/123');
    expect(comment).not.toContain('<script>');
});
