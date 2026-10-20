// Track files changed by an individual Codex turn so parallel agents do not share check scope.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ROOT } from './check.mjs';
import { patchedFiles } from './guard.mjs';

function hash(value) {
    return createHash('sha256').update(value).digest('hex');
}

function repoPath(root, file, cwd = root) {
    const absolute = path.resolve(cwd, file);
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) return undefined;
    return relative;
}

function fileFingerprint(root, file) {
    const absolute = path.join(root, ...file.split('/'));
    try {
        const info = fs.lstatSync(absolute);
        if (info.isDirectory()) return `${info.mode}:directory`;
        const content = info.isSymbolicLink() ? fs.readlinkSync(absolute) : fs.readFileSync(absolute);
        return `${info.mode}:${hash(content)}`;
    } catch (error) {
        if (error.code === 'ENOENT') return 'deleted';
        throw error;
    }
}

function parseSnapshot(root, output) {
    const snapshot = new Map();
    const entries = output.split('\0');
    for (let index = 0; index < entries.length; index++) {
        const entry = entries[index] ?? '';
        if (entry.length < 4) continue;

        const status = entry.slice(0, 2);
        const file = repoPath(root, entry.slice(3));
        if (file !== undefined) snapshot.set(file, `${status}:${fileFingerprint(root, file)}`);

        if (/[RC]/.test(status) && entries[index + 1]) {
            const source = repoPath(root, entries[++index]);
            if (source !== undefined) snapshot.set(source, `${status}:${fileFingerprint(root, source)}`);
        }
    }
    return snapshot;
}

/**
 * Capture changed paths and their current content/status fingerprints.
 *
 * @param {string} [root]
 * @param {string[]} [files] Limit the snapshot to these repo paths; all changed paths when omitted.
 */
export function snapshotWorkingTree(root = ROOT, files) {
    if (files?.length === 0) return new Map();
    const pathspecs = files === undefined ? [] : ['--', ...files.map((file) => `:(literal)${file}`)];
    const result = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all', ...pathspecs], {
        cwd: root,
        encoding: 'buffer',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`git status failed: ${result.stderr.toString('utf8')}`);
    return parseSnapshot(root, result.stdout.toString('utf8'));
}

function changedPaths(before, after) {
    const paths = new Set([...before.keys(), ...after.keys()]);
    return [...paths].filter((file) => before.get(file) !== after.get(file));
}

/** Find shell output redirection destinations, the only file targets Bash declares directly. */
function shellOutputTargets(command) {
    return [...command.matchAll(/(?:^|[^<])(?:\d+)?(>>?)\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g)]
        .map((match) => match[2] ?? match[3] ?? match[4])
        .filter((file) => typeof file === 'string' && file !== '' && !file.startsWith('&'));
}

function toolTargets(root, request) {
    const input = request.tool_input ?? {};
    let files = [];
    if (request.tool_name === 'apply_patch') {
        const patch = typeof input === 'string' ? input : (input.patchText ?? input.patch ?? input.command);
        if (typeof patch === 'string') files = patchedFiles(patch);
    } else if (request.tool_name === 'Bash' && typeof input.command === 'string') {
        files = shellOutputTargets(input.command);
    }

    return new Set(files.map((file) => repoPath(root, file, request.cwd ?? root)).filter((file) => file !== undefined));
}

function toolKey(request) {
    if (
        typeof request?.session_id !== 'string' ||
        typeof request?.turn_id !== 'string' ||
        typeof request?.tool_use_id !== 'string'
    ) {
        return undefined;
    }
    return {
        turnDirectory: `${hash(request.session_id).slice(0, 24)}/${hash(request.turn_id).slice(0, 24)}`,
        tool: hash(request.tool_use_id).slice(0, 24),
    };
}

/** The completion scope a Stop or SubagentStop request belongs to: the root agent or one subagent. */
export function completionIdentity(request) {
    return request?.hook_event_name === 'SubagentStop' ? `subagent:${request.agent_id ?? request.turn_id}` : 'root';
}

/**
 * Persists changed-file scope by Codex session and turn, including a bounded completion retry.
 */
export class HookScope {
    /**
     * @param {{ root?: string, directory?: string, snapshot?: (root: string, files: string[]) => Map<string, string> }} [options]
     */
    constructor(options = {}) {
        this.root = options.root ?? ROOT;
        this.directory = options.directory ?? path.join(os.tmpdir(), 'pumpkin-plugins-hook-scopes', hash(this.root));
        this.snapshot = options.snapshot ?? snapshotWorkingTree;
    }

    /** Save a pre-tool snapshot of the tool's file targets for a later PostToolUse comparison. */
    beforeTool(request) {
        const key = toolKey(request);
        const targets = toolTargets(this.root, request);
        if (!key || targets.size === 0) return;

        const directory = path.join(this.directory, key.turnDirectory, 'pending');
        fs.mkdirSync(directory, { recursive: true });
        const pending = path.join(directory, `${key.tool}.json`);
        const temporary = `${pending}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify([...this.snapshot(this.root, [...targets])]));
        fs.renameSync(temporary, pending);
    }

    /** Record paths whose working-tree state changed during the tool call. */
    afterTool(request) {
        const key = toolKey(request);
        if (!key) return;

        const turnDirectory = path.join(this.directory, key.turnDirectory);
        const pending = path.join(turnDirectory, 'pending', `${key.tool}.json`);
        if (!fs.existsSync(pending)) return;

        const targets = toolTargets(this.root, request);
        const before = new Map(JSON.parse(fs.readFileSync(pending, 'utf8')));
        const after = this.snapshot(this.root, [...targets]);
        const filesDirectory = path.join(turnDirectory, 'files');
        const changed = changedPaths(before, after).filter((file) => targets.has(file));
        if (changed.length > 0) fs.mkdirSync(filesDirectory, { recursive: true });
        for (const file of changed) {
            const marker = path.join(filesDirectory, Buffer.from(file).toString('base64url'));
            try {
                fs.writeFileSync(marker, '', { flag: 'wx' });
            } catch (error) {
                if (error.code !== 'EEXIST') throw error;
            }
        }
        fs.rmSync(pending, { force: true });
    }

    /** Return this turn's files and, on the single retry, its prior failed-check scope. */
    files(sessionId, turnId, options = {}) {
        if (typeof sessionId !== 'string' || typeof turnId !== 'string') return [];
        const sessionDirectory = path.join(this.directory, hash(sessionId).slice(0, 24));
        const turnDirectory = path.join(sessionDirectory, hash(turnId).slice(0, 24));
        const files = new Set();
        const filesDirectory = path.join(turnDirectory, 'files');
        if (fs.existsSync(filesDirectory)) {
            for (const name of fs.readdirSync(filesDirectory)) files.add(Buffer.from(name, 'base64url').toString());
        }

        const identity = options.identity ?? 'root';
        const checkpoint = path.join(sessionDirectory, `checkpoint-${hash(identity).slice(0, 24)}.json`);
        if (options.retrying === true && fs.existsSync(checkpoint)) {
            for (const file of JSON.parse(fs.readFileSync(checkpoint, 'utf8'))) files.add(file);
        }
        return [...files].sort();
    }

    /** Keep a failed scope for one continuation, then clear it to prevent stale cross-turn checks. */
    finish(request, files, passed) {
        if (typeof request?.session_id !== 'string') return;
        const sessionDirectory = path.join(this.directory, hash(request.session_id).slice(0, 24));
        const checkpoint = path.join(
            sessionDirectory,
            `checkpoint-${hash(completionIdentity(request)).slice(0, 24)}.json`,
        );
        if (passed === true || request.stop_hook_active === true || files.length === 0) {
            fs.rmSync(checkpoint, { force: true });
            this.removeTurn(request);
            return;
        }

        fs.mkdirSync(sessionDirectory, { recursive: true });
        const temporary = `${checkpoint}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify([...new Set(files)].sort()));
        fs.renameSync(temporary, checkpoint);
        this.removeTurn(request);
    }

    removeTurn(request) {
        if (typeof request?.session_id !== 'string' || typeof request?.turn_id !== 'string') return;
        const turnDirectory = path.join(
            this.directory,
            hash(request.session_id).slice(0, 24),
            hash(request.turn_id).slice(0, 24),
        );
        fs.rmSync(turnDirectory, { recursive: true, force: true });
    }
}

export const hookScope = new HookScope();
