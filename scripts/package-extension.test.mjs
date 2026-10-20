// Tests that VSIX packaging leaves the extension's package.json as it found it.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, it } from 'node:test';

const script = path.join(import.meta.dirname, 'package-extension.mjs');
const dirs = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

it('restores package.json when packaging is interrupted', { skip: process.platform === 'win32' }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'package-extension-'));
    dirs.push(dir);
    const manifest = `${JSON.stringify({ name: 'example', devDependencies: { helper: 'workspace:*' } }, null, 4)}\n`;
    fs.writeFileSync(path.join(dir, 'package.json'), manifest);
    fs.mkdirSync(path.join(dir, 'node_modules', 'helper'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'helper', 'package.json'), '{"version":"1.0.0"}');
    fs.mkdirSync(path.join(dir, 'node_modules', '.bin'));
    const started = path.join(dir, 'started');
    fs.writeFileSync(path.join(dir, 'node_modules', '.bin', 'vsce'), `#!/bin/sh\ntouch '${started}'\nsleep 10\n`, {
        mode: 0o755,
    });

    // A process group signal reaches both scripts, as Ctrl+C does in a terminal.
    const child = spawn(process.execPath, [script], { cwd: dir, detached: true, stdio: 'ignore' });
    const exited = once(child, 'exit');
    while (!fs.existsSync(started)) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.notEqual(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'), manifest);
    process.kill(-child.pid, 'SIGTERM');
    await exited;

    assert.equal(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'), manifest);
});

it('declares every bundled workspace package as a dev dependency, so Turbo rebuilds the extension when it changes', () => {
    const extensions = path.join(import.meta.dirname, '../extensions');
    for (const name of fs.readdirSync(extensions)) {
        const manifestFile = path.join(extensions, name, 'package.json');
        if (!fs.existsSync(manifestFile)) continue;
        const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
        for (const bundled of manifest.pumpkinBundleDependencies ?? []) {
            assert.equal(manifest.devDependencies?.[bundled], 'workspace:*', `${name} bundles ${bundled}`);
        }
    }
});
