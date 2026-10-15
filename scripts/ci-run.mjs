import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { constants } from 'node:os';
import * as path from 'node:path';
import { ciOutputDirectory } from './utils/ci-output.mjs';

const separator = process.argv.indexOf('--');
if (separator !== 3 || process.argv.length <= separator + 1) {
    throw new Error('Usage: ci-run.mjs <label> -- <command> [args...]');
}
const label = process.argv[2];
const [command, ...args] = process.argv.slice(separator + 1);
const directory = ciOutputDirectory();
fs.mkdirSync(directory, { recursive: true });
const stem = path.join(directory, randomUUID());
const summaryFile = `${stem}.md`;
const startedAt = Date.now();
// Leave stdout/stderr untouched: annotations, diagnostics and log groups still reach GitHub.
const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: { ...process.env, GITHUB_STEP_SUMMARY: summaryFile },
    shell: process.platform === 'win32' && /\.(?:cmd|bat)$|^pnpm$/i.test(command),
});
if (result.error) console.error(result.error.message);
const exitCode = result.status ?? (result.signal ? 128 + (constants.signals[result.signal] ?? 0) : 1);
fs.writeFileSync(
    `${stem}.json`,
    JSON.stringify({
        label,
        startedAt,
        durationMs: Date.now() - startedAt,
        exitCode,
        signal: result.signal,
        report: fs.existsSync(summaryFile) ? fs.readFileSync(summaryFile, 'utf8') : '',
    }),
);
process.exitCode = exitCode;
