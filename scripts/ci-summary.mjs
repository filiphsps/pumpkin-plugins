import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { ciOutputDirectory, combineVitestReports, escapeSummaryText, formatTestStats } from './utils/ci-output.mjs';

const { values } = parseArgs({ options: { title: { type: 'string' }, tests: { type: 'boolean' } } });
if (!values.title) throw new Error('Usage: ci-summary.mjs --title <title> [--tests]');
const directory = ciOutputDirectory();
const commands = fs.existsSync(directory)
    ? fs
          .readdirSync(directory)
          .filter((file) => file.endsWith('.json'))
          .map((file) => JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8')))
          .sort((left, right) => left.startedAt - right.startedAt)
    : [];
const status = process.env.CI_JOB_STATUS;
let summary = `## ${escapeSummaryText(values.title)}${status ? ` — ${escapeSummaryText(status)}` : ''}\n\n`;
if (commands.length) {
    summary += `| Check | Result | Time |${values.tests ? ' Executed Vitest cases |' : ''}\n`;
    summary += `| --- | --- | ---: |${values.tests ? ' --- |' : ''}\n`;
}
const details = [];
for (const command of commands) {
    const result =
        command.exitCode === 0
            ? '✅ Passed'
            : `❌ Failed (exit ${command.exitCode}${command.signal ? `, ${command.signal}` : ''})`;
    const combined = combineVitestReports(command.report);
    summary += `| ${escapeSummaryText(command.label)} | ${result} | ${(command.durationMs / 1000).toFixed(1)}s |`;
    if (values.tests) summary += ` ${combined.reports ? formatTestStats(combined.stats) : '—'} |`;
    summary += '\n';
    if (values.tests && combined.details)
        details.push(
            `<details>\n<summary>${escapeSummaryText(command.label)}: reporter details</summary>\n\n${combined.details.slice(0, 32_000)}${combined.details.length > 32_000 ? '\n\nReporter details truncated; open the test step log for full diagnostics.' : ''}\n\n</details>\n`,
        );
}
if (values.tests)
    summary +=
        '\nCounts cover freshly executed Vitest suites. Cached suites and Node test results remain in the command logs. Failures retain their source annotations.\n';
if (process.env.CI_ARTIFACT_URL) {
    const url = new URL(process.env.CI_ARTIFACT_URL);
    if (url.protocol !== 'https:') throw new Error('Artifact links must use HTTPS');
    summary += `\n[${escapeSummaryText(process.env.CI_LINK_LABEL ?? 'Download artifacts')}](${url.href})\n`;
}
if (process.env.CI_SUMMARY_NOTE) summary += `\n${escapeSummaryText(process.env.CI_SUMMARY_NOTE)}\n`;
const facts = Object.entries(JSON.parse(process.env.CI_SUMMARY_FACTS ?? '{}'));
if (facts.length) {
    summary += '\n| Detail | Value |\n| --- | --- |\n';
    for (const [name, value] of facts)
        summary += `| ${escapeSummaryText(name.replaceAll('_', ' '))} | ${escapeSummaryText(typeof value === 'object' ? JSON.stringify(value) : value)} |\n`;
}
if (process.env.CI_PLUGINS_MANIFEST && fs.existsSync(process.env.CI_PLUGINS_MANIFEST)) {
    const plugins = JSON.parse(fs.readFileSync(process.env.CI_PLUGINS_MANIFEST, 'utf8'));
    summary += '\n| Plugin | Version | Component size | File |\n| --- | --- | ---: | --- |\n';
    for (const plugin of plugins) {
        const file = plugin['wasm-file'];
        summary += `| ${escapeSummaryText(plugin['plugin-name'])} | ${escapeSummaryText(plugin.version)} | ${(fs.statSync(file).size / 1024).toFixed(1)} KiB | ${escapeSummaryText(path.basename(file))} |\n`;
    }
}
summary += `\n${details.join('\n')}`;
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
else process.stdout.write(summary);
