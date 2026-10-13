import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { resolveConsumerWorkspaceRoot } from './workspace-root.ts';

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it('uses the nearest pnpm workspace root for a package run inside the monorepo', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-workspace-'));
    roots.push(workspaceRoot);
    const packageDirectory = path.join(workspaceRoot, 'tools/static-hermes-runtime');
    fs.mkdirSync(packageDirectory, { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, 'pnpm-workspace.yaml'), 'packages:\n  - tools/*\n');

    expect(resolveConsumerWorkspaceRoot(packageDirectory)).toBe(workspaceRoot);
});

it('uses a standalone consumer directory when it has no pnpm workspace ancestor', () => {
    const consumerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-consumer-'));
    roots.push(consumerRoot);

    expect(resolveConsumerWorkspaceRoot(consumerRoot)).toBe(consumerRoot);
});

it('preserves a valid logical working directory path', () => {
    const consumerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-logical-cwd-'));
    roots.push(consumerRoot);
    const originalWorkingDirectory = process.cwd();
    const originalPwd = process.env.PWD;
    process.chdir(consumerRoot);
    process.env.PWD = consumerRoot;

    try {
        expect(resolveConsumerWorkspaceRoot()).toBe(consumerRoot);
    } finally {
        process.chdir(originalWorkingDirectory);
        if (originalPwd === undefined) delete process.env.PWD;
        else process.env.PWD = originalPwd;
    }
});
