import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { ROOT } from './check.mjs';
import { handle, repoPath } from './run.mjs';

describe('portable hook protocol', () => {
    it('normalizes file paths from a package cwd and refuses outside paths', () => {
        assert.equal(
            repoPath('src/plugin.ts', path.join(ROOT, 'packages/upnpumpkin')),
            'packages/upnpumpkin/src/plugin.ts'
        );
        assert.equal(repoPath(path.join(ROOT, '.agents/hooks/run.mjs')), '.agents/hooks/run.mjs');
        assert.throws(() => repoPath('../elsewhere/file.ts'), /outside this repo/);
    });

    it('guards all supported shell aliases and preserves other input fields', async () => {
        for (const tool of ['shell', 'bash', 'exec_command']) {
            assert.equal((await handle({ event: 'before-tool', tool, input: { cmd: 'npm install x' } })).ok, false);
            const result = await handle({ event: 'before-tool', tool, input: { command: 'pnpm test', timeout: 30 } });
            assert.deepEqual(result, {
                ok: true,
                input: { command: 'pnpm test --output-logs=errors-only', timeout: 30 }
            });
        }
    });

    it('guards edits and patches while permitting build-tool source edits', async () => {
        const refused = await handle({
            event: 'before-tool',
            tool: 'write',
            input: { filePath: 'pnpm-lock.yaml', content: '' }
        });
        assert.equal(refused.ok, false);
        const allowed = await handle({
            event: 'before-tool',
            tool: 'edit',
            input: { path: 'tools/build/src/cli.ts', oldString: 'x' }
        });
        assert.equal(allowed.ok, true);
        for (const input of ['*** Delete File: pnpm-lock.yaml', { patchText: '*** Move to: pnpm-lock.yaml' }]) {
            const result = await handle({ event: 'before-tool', tool: 'apply_patch', input });
            assert.equal(result.ok, false);
        }
    });

    it('plans explicit files without inspecting git or executing checks', async () => {
        const result = await handle(
            { event: 'plan', files: ['src/plugin.ts'], cwd: path.join(ROOT, 'packages/upnpumpkin') },
            {
                changedFiles: () => assert.fail('must not read git'),
                runChecks: () => assert.fail('must not execute')
            }
        );
        assert.equal(result.ok, true);
        assert.deepEqual(result.files, ['packages/upnpumpkin/src/plugin.ts']);
        assert.ok(result.steps.some((s) => s.args.includes('--filter=...@pumpkin-plugins/upnpumpkin')));
    });

    it('checks git-discovered files and returns useful failure output', async () => {
        const failure = { step: { name: 'Repo checks', args: ['check'] }, output: 'broken link' };
        let ran = false;
        const result = await handle(
            { event: 'check' },
            {
                changedFiles: async () => ['docs/testing.md'],
                runChecks: async (steps) => {
                    ran = true;
                    assert.ok(steps.some((s) => s.args[0] === 'check'));
                    return [failure];
                }
            }
        );
        assert.equal(ran, true);
        assert.equal(result.ok, false);
        assert.deepEqual(result.failures, [failure]);
        assert.match(result.report, /broken link/);
    });

    it('rejects malformed requests and passes through unknown tools', async () => {
        await assert.rejects(handle({ event: 'unknown' }), /Unknown hook event/);
        await assert.rejects(handle({ event: 'check', files: 'x' }), /files must be/);
        await assert.rejects(handle({ event: 'before-tool', tool: 'bash', input: {} }), /Shell input/);
        assert.deepEqual(await handle({ event: 'before-tool', tool: 'read', input: { path: 'x' } }), {
            ok: true,
            input: { path: 'x' }
        });
    });

    it('emits only JSON with meaningful CLI exit codes', () => {
        for (const [input, code] of [
            ['{"event":"check","files":[]}', 0],
            ['{"event":"before-tool","tool":"bash","input":{"command":"yarn add x"}}', 1],
            ['not JSON', 1]
        ]) {
            const result = spawnSync(process.execPath, [path.join(ROOT, '.agents/hooks/run.mjs')], {
                input,
                encoding: 'utf8'
            });
            assert.equal(result.status, code, result.stderr);
            assert.equal(JSON.parse(result.stdout).ok, code === 0);
        }
    });
});
