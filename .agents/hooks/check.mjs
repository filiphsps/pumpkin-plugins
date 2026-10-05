#!/usr/bin/env node
// The checks CI would fail on, scoped to the files that changed: Biome and the JSDoc lint on those
// files, typecheck and unit tests of the packages they belong to (and of the packages that depend on
// a changed package), and the repo checks. Integration tests are left out because they need a server.
//
//   node .agents/hooks/check.mjs            check the files git reports as changed
//   node .agents/hooks/check.mjs <file>...  check these files
//
// Exits with 1 and prints what failed when a check fails. Any agent can invoke this runner directly
// or use the client-neutral JSON entry point in run.mjs. Use --plan to preview the commands.
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Repo root, from where this file lives. */
export const ROOT = path.resolve(import.meta.dirname, '../..');

/** Files whose change can affect every package, so every package is checked. */
const SHARED = [
    /^package\.json$/,
    /^pnpm-workspace\.yaml$/,
    /^tsconfig\.base\.json$/,
    /^turbo\.json$/,
    /^turbo\/generators\//,
    /^pnpm-lock\.yaml$/
];

const LINT_CONFIG = /^(biome\.json|eslint\.config\.mjs)$/;

/** Paths that contain generated output, without confusing tools/build with an output folder. */
export function isGeneratedPath(file) {
    return /^(dist|build|\.cache|\.turbo)\/|^(packages|tools)\/[^/]+\/(build|dist)\/|(^|\/)(node_modules|\.cache|\.turbo|coverage)\//.test(
        file
    );
}

/**
 * @typedef {{ name: string, args: string[] }} Step A check, run as `pnpm <args>` from the repo root.
 */

/**
 * The checks to run for a set of changed files.
 *
 * @param {string[]} files Changed paths relative to the repo root, including deleted ones.
 * @param {(file: string) => boolean} [exists] Whether a path exists (deleted files aren't linted).
 * @param {(dir: string) => string | undefined} [packageName] The `name` in `<dir>/package.json`.
 * @returns {Step[]}
 */
export function planChecks(files, exists = defaultExists, packageName = defaultPackageName) {
    const relevant = [...new Set(files)].filter((f) => !isGeneratedPath(f));
    if (relevant.length === 0) return [];

    const steps = [];
    const present = relevant.filter(exists);
    if (relevant.some((f) => LINT_CONFIG.test(f))) {
        steps.push({ name: 'Repo lint', args: ['lint'] });
    } else if (present.length > 0) {
        steps.push({
            name: 'Biome',
            args: ['exec', 'biome', 'check', '--no-errors-on-unmatched', '--files-ignore-unknown=true', ...present]
        });
        const ts = present.filter((f) => /\.[cm]?ts$/.test(f));
        if (ts.length > 0) steps.push({ name: 'JSDoc', args: ['exec', 'eslint', '--no-warn-ignored', ...ts] });
    }

    const filters = new Set();
    let everything = false;
    for (const file of relevant) {
        if (SHARED.some((p) => p.test(file))) everything = true;
        const match = /^(packages|tools)\/([^/]+)\//.exec(file);
        if (!match) continue;
        const name = packageName(`${match[1]}/${match[2]}`);
        if (!name) {
            everything = true; // A removed package can leave broken imports in its dependents.
            continue;
        }
        // Include workspace consumers, including plugins that depend on another plugin.
        if (!file.endsWith('.md')) filters.add(`...${name}`);
    }
    if (everything || filters.size > 0) {
        steps.push({
            name: 'Typecheck and unit tests',
            args: [
                'exec',
                'turbo',
                'run',
                'typecheck',
                'test',
                '--output-logs=errors-only',
                ...(everything ? [] : [...filters].sort().map((f) => `--filter=${f}`))
            ]
        });
    }

    if (relevant.some((f) => /^(scripts|\.agents\/hooks)\/|^package\.json$/.test(f))) {
        steps.push({ name: 'Script tests', args: ['test:scripts'] });
    }
    steps.push({ name: 'Repo checks', args: ['check'] });
    steps.push({ name: 'Generated READMEs', args: ['readme:check'] });
    return steps;
}

function defaultExists(file) {
    return fs.existsSync(path.join(ROOT, file));
}

function defaultPackageName(dir) {
    try {
        return JSON.parse(fs.readFileSync(path.join(ROOT, dir, 'package.json'), 'utf8')).name;
    } catch {
        return undefined;
    }
}

/**
 * Paths git reports as changed, staged or untracked, relative to the repo root.
 *
 * @returns {Promise<string[]>}
 */
export async function changedFiles() {
    const { code, output } = await exec('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    if (code !== 0) throw new Error(`git status failed:\n${output}`);
    return parseStatus(output);
}

/** Parse NUL-delimited git status, keeping both sides of renames and copies. */
export function parseStatus(output) {
    const entries = output.split('\0');
    const files = [];
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i] ?? '';
        if (entry.length < 4) continue;
        files.push(entry.slice(3));
        if (/[RC]/.test(entry.slice(0, 2)) && entries[i + 1]) files.push(entries[++i]);
    }
    return [...new Set(files)];
}

/**
 * Runs the steps one after another and returns the ones that failed, with their output.
 *
 * @param {Step[]} steps
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{ step: Step, output: string }[]>}
 */
export async function runChecks(steps, options = {}) {
    const failures = [];
    for (const step of steps) {
        options.signal?.throwIfAborted();
        const { code, output } = await exec('pnpm', step.args, options.signal);
        options.signal?.throwIfAborted();
        if (code !== 0) failures.push({ step, output: trim(output) });
    }
    return failures;
}

/** Long output keeps its head (the first errors) and its tail (the summary). */
function trim(output, head = 150, tail = 50) {
    const lines = output.trimEnd().split('\n');
    if (lines.length <= head + tail) return lines.join('\n');
    return [...lines.slice(0, head), `... ${lines.length - head - tail} lines cut ...`, ...lines.slice(-tail)].join(
        '\n'
    );
}

/**
 * A report of failed checks, for a person or an agent to act on.
 *
 * @param {{ step: Step, output: string }[]} failures
 * @returns {string}
 */
export function formatFailures(failures) {
    return failures
        .map(
            ({ step, output }) =>
                `### ${step.name} failed: \`pnpm ${step.args.join(' ')}\`\n\n\`\`\`\n${output}\n\`\`\``
        )
        .join('\n\n');
}

function exec(command, args, signal) {
    return new Promise((resolve) => {
        const child = spawn(command, args, {
            cwd: ROOT,
            env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
            signal,
            timeout: 10 * 60 * 1000
        });
        let output = '';
        child.stdout.on('data', (chunk) => {
            output += chunk;
        });
        child.stderr.on('data', (chunk) => {
            output += chunk;
        });
        child.on('error', (error) => resolve({ code: 1, output: `${output}\n${error.message}` }));
        child.on('close', (code) => resolve({ code: code ?? 1, output }));
    });
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
    const args = process.argv.slice(2);
    const preview = args[0] === '--plan';
    if (preview) args.shift();
    const files =
        args.length > 0
            ? args.map((file) => {
                  const rel = path.relative(ROOT, path.resolve(file)).split(path.sep).join('/');
                  if (rel === '..' || rel.startsWith('../') || path.isAbsolute(rel) || rel.startsWith('-')) {
                      throw new Error(`Expected a repo file, got: ${file}`);
                  }
                  return rel;
              })
            : await changedFiles();
    const steps = planChecks(files);
    if (preview) {
        console.log(JSON.stringify({ files, steps }, null, 2));
        process.exit(0);
    }
    if (steps.length === 0) {
        console.log('Nothing to check.');
        process.exit(0);
    }
    console.log(`Checking ${files.length} changed file(s): ${steps.map((s) => s.name).join(', ')}`);
    const failures = await runChecks(steps);
    if (failures.length > 0) {
        console.error(formatFailures(failures));
        process.exit(1);
    }
    console.log('All checks passed.');
}
