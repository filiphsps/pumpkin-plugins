#!/usr/bin/env node
// Client-neutral hook protocol. Read one JSON request from stdin, write one JSON response to stdout.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { changedFiles, formatFailures, planChecks, ROOT, runChecks } from './check.mjs';
import { checkEdit, checkShell, patchedFiles } from './guard.mjs';
import { quietTurbo } from './output.mjs';

const SHELL = new Set(['shell', 'bash', 'exec_command']);
const PATCH = new Set(['patch', 'apply_patch']);
const EDIT = new Set(['edit', 'write']);

function read(file) {
    try {
        return fs.readFileSync(path.join(ROOT, file), 'utf8');
    } catch {
        return undefined;
    }
}

/** Normalize paths from an agent's working directory, rejecting paths outside this repo. */
export function repoPath(file, cwd = ROOT) {
    const rel = path.relative(ROOT, path.resolve(cwd, file)).split(path.sep).join('/');
    if (rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) {
        throw new Error(`Path is outside this repo: ${file}`);
    }
    return rel;
}

/** Handle a portable before-tool, plan or check request. Client adapters decide how to use the result. */
export async function handle(request, checks = { changedFiles, runChecks }) {
    if (!request || typeof request !== 'object') throw new Error('Expected a JSON request object');
    const cwd = request.cwd ?? ROOT;
    if (request.event === 'before-tool') {
        const { tool, input = {} } = request;
        if (SHELL.has(tool)) {
            const command = input.command ?? input.cmd;
            if (typeof command !== 'string') throw new Error('Shell input needs command or cmd');
            const reason = checkShell(command);
            if (reason) return { ok: false, reason };
            const key = input.command === undefined ? 'cmd' : 'command';
            return { ok: true, input: { ...input, [key]: quietTurbo(command) } };
        }
        let targets = [];
        if (PATCH.has(tool)) {
            const patch = typeof input === 'string' ? input : (input.patchText ?? input.patch ?? input.command);
            if (typeof patch !== 'string') throw new Error('Patch input needs patchText, patch or command');
            targets = patchedFiles(patch).map((file) => ({ file, change: {} }));
        } else if (EDIT.has(tool)) {
            const file = input.path ?? input.filePath;
            if (typeof file !== 'string') throw new Error('Edit input needs path or filePath');
            targets = [
                { file, change: { oldString: input.oldString, content: tool === 'write' ? input.content : undefined } }
            ];
        }
        for (const { file, change } of targets) {
            const rel = repoPath(file, cwd);
            const reason = checkEdit(rel, change, read);
            if (reason) return { ok: false, reason: `${rel}: ${reason}` };
        }
        return { ok: true, input };
    }
    if (request.event !== 'plan' && request.event !== 'check') {
        throw new Error(`Unknown hook event: ${request.event}`);
    }
    if (
        request.files !== undefined &&
        (!Array.isArray(request.files) || request.files.some((f) => typeof f !== 'string'))
    ) {
        throw new Error('files must be an array of repo paths');
    }
    const files =
        request.files === undefined ? await checks.changedFiles() : request.files.map((f) => repoPath(f, cwd));
    const steps = planChecks(files);
    if (request.event === 'plan') return { ok: true, files, steps };
    const failures = await checks.runChecks(steps);
    return { ok: failures.length === 0, files, failures, report: formatFailures(failures) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
    try {
        let input = '';
        for await (const chunk of process.stdin) input += chunk;
        const result = await handle(JSON.parse(input));
        console.log(JSON.stringify(result));
        process.exitCode = result.ok ? 0 : 1;
    } catch (error) {
        console.log(JSON.stringify({ ok: false, error: error.message }));
        process.exitCode = 1;
    }
}
