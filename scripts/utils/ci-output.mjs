import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Locate command reports outside cached workspace outputs, scoped to this job and attempt. */
export function ciOutputDirectory() {
    return (
        process.env.PUMPKIN_CI_OUTPUT_DIR ??
        path.join(
            process.env.RUNNER_TEMP ?? path.resolve('.cache'),
            `ci-output-${process.env.GITHUB_JOB ?? 'local'}-${process.env.GITHUB_RUN_ATTEMPT ?? '1'}`,
        )
    );
}

/** Escape dynamic text for a Markdown table cell or heading. */
export function escapeSummaryText(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('|', '&#124;')
        .replaceAll('\r', '')
        .replaceAll('\n', ' ');
}

/** Combine Vitest's built-in summaries while retaining flaky links and unrecognized output. */
export function combineVitestReports(markdown) {
    const stats = { passed: 0, failed: 0, expected: 0, skipped: 0, todo: 0 };
    let reports = 0;
    const details = markdown
        .replace(
            /^## (?:\([^\n]*\) )?Vitest Test Report\r?\n\s*### Summary\r?\n\s*- \*\*Test Files\*\*:[^\n]*\r?\n- \*\*Test Results\*\*:([^\n]*)\r?\n(?:- \*\*Other\*\*:([^\n]*)\r?\n)?/gm,
            (_report, results, other = '') => {
                reports++;
                const patterns = {
                    passed: /(\d+) passes?\b/g,
                    failed: /(\d+) failures?\b/g,
                    expected: /(\d+) expected failures?\b/g,
                    skipped: /(\d+) skips?\b/g,
                    todo: /(\d+) todos?\b/g,
                };
                for (const [key, pattern] of Object.entries(patterns)) {
                    for (const [, count] of `${results} ${other}`.matchAll(pattern)) stats[key] += Number(count);
                }
                return '';
            },
        )
        .trim();
    return { stats, reports, details };
}

/** Describe executed Vitest cases without treating skipped or expected failures as passes. */
export function formatTestStats(stats) {
    return [
        `${stats.passed} passed`,
        `${stats.failed} failed`,
        ...(stats.expected ? [`${stats.expected} expected failure${stats.expected === 1 ? '' : 's'}`] : []),
        ...(stats.skipped ? [`${stats.skipped} skipped`] : []),
        ...(stats.todo ? [`${stats.todo} todo`] : []),
    ].join(' · ');
}

/** Append a step output with a random heredoc delimiter, so line breaks in the value stay inside it. */
export function setOutput(name, value) {
    const outputFile = process.env.GITHUB_OUTPUT;
    if (!outputFile) throw new Error('GITHUB_OUTPUT is required');
    const delimiter = `ghadelimiter_${randomUUID()}`; // cspell:disable-line
    fs.appendFileSync(outputFile, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

/** Read a required environment variable, trimmed, or throw an error naming it. */
export function requiredEnvironment(name) {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
}
