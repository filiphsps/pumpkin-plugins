// Tests for the agent hooks. Run with `pnpm test:scripts`.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseStatus, planChecks, runChecks } from './check.mjs';
import { checkEdit, checkShell, patchedFiles } from './guard.mjs';
import { quietTurbo } from './output.mjs';

describe('checkShell', () => {
    it('refuses other package managers wherever a command starts', () => {
        for (const command of [
            'npm install left-pad',
            'npx vitest run',
            'yarn add x',
            'bunx tsc',
            'cd packages/upnpumpkin && npm i',
            'pnpm build; npx biome check'
        ]) {
            assert.match(checkShell(command) ?? '', /pnpm/, command);
        }
    });

    it('allows pnpm and read-only npm commands', () => {
        for (const command of [
            'pnpm add -D x',
            'pnpm exec vitest run',
            'npm view turbo version',
            'echo "npx is banned"'
        ]) {
            assert.equal(checkShell(command), undefined, command);
        }
    });
});

describe('checkEdit', () => {
    const readme = [
        '# Plugin',
        '',
        'Hand-written intro.',
        '',
        '<!-- docs:begin commands -->',
        '| Command | |',
        '<!-- docs:end commands -->',
        '',
        'Hand-written outro.'
    ].join('\n');
    const read = (file) => (file === 'packages/p/README.md' ? readme : undefined);

    it('refuses the lockfile, build output, caches and release-please files', () => {
        for (const file of [
            'pnpm-lock.yaml',
            'packages/p/build/p.wasm',
            'tools/build/build/p.wasm',
            'tools/config/dist/index.js',
            'dist/p.wasm',
            '.cache/pumpkin/x',
            'tools/config/node_modules/x/index.js',
            'packages/p/CHANGELOG.md',
            'tools/config/CHANGELOG.md',
            '.release-please-manifest.json'
        ]) {
            assert.ok(checkEdit(file, {}, read), file);
        }
        assert.equal(checkEdit('packages/p/src/build.ts', {}, read), undefined);
        assert.equal(checkEdit('tools/build/src/cli.ts', {}, read), undefined);
        assert.equal(checkEdit('release-please-config.json', {}, read), undefined);
    });

    it('refuses edits inside a generated README block and allows the rest', () => {
        assert.match(checkEdit('packages/p/README.md', { oldString: '| Command | |' }, read) ?? '', /pnpm readme/);
        assert.match(
            checkEdit('packages/p/README.md', { oldString: 'intro.\n\n<!-- docs:begin' }, read) ?? '',
            /pnpm readme/
        );
        assert.equal(checkEdit('packages/p/README.md', { oldString: 'Hand-written outro.' }, read), undefined);
    });

    it('refuses patch-style edits to READMEs with generated blocks', () => {
        assert.match(checkEdit('packages/p/README.md', {}, read) ?? '', /pnpm readme/);
    });

    it('refuses a rewrite that changes a generated block and allows one that keeps it', () => {
        const kept = readme.replace('Hand-written intro.', 'A better intro.');
        assert.equal(checkEdit('packages/p/README.md', { content: kept }, read), undefined);
        const changed = readme.replace('| Command | |', '| Command | Notes |');
        assert.match(checkEdit('packages/p/README.md', { content: changed }, read) ?? '', /pnpm readme/);
        const dropped = '# Plugin\n';
        assert.match(checkEdit('packages/p/README.md', { content: dropped }, read) ?? '', /pnpm readme/);
    });

    it('lists the files a patch touches', () => {
        const patch = [
            '*** Begin Patch',
            '*** Update File: packages/p/src/a.ts',
            '@@',
            '*** Add File: packages/p/src/b.ts',
            '*** Delete File: pnpm-lock.yaml',
            '*** End Patch'
        ].join('\n');
        assert.deepEqual(patchedFiles(patch), ['packages/p/src/a.ts', 'packages/p/src/b.ts', 'pnpm-lock.yaml']);
    });
});

describe('quietTurbo', () => {
    it('adds --output-logs=errors-only to plain Turborepo runs', () => {
        assert.equal(quietTurbo('pnpm test'), 'pnpm test --output-logs=errors-only');
        assert.equal(quietTurbo('pnpm run typecheck'), 'pnpm run typecheck --output-logs=errors-only');
        assert.equal(
            quietTurbo('pnpm exec turbo run build --filter=...@pumpkin-plugins/upnpumpkin'),
            'pnpm exec turbo run build --filter=...@pumpkin-plugins/upnpumpkin --output-logs=errors-only'
        );
    });

    it('leaves everything else alone', () => {
        for (const command of [
            'pnpm lint',
            'pnpm readme',
            'pnpm test --output-logs=full',
            'pnpm test | tail',
            'pnpm test && pnpm lint',
            'pnpm test -- --project unit',
            'pnpm testing',
            'pnpm exec vitest run'
        ]) {
            assert.equal(quietTurbo(command), command, command);
        }
    });
});

describe('planChecks', () => {
    const names = {
        'packages/upnpumpkin': '@pumpkin-plugins/upnpumpkin',
        'tools/config': '@pumpkin-plugins/config',
        'tools/build': '@pumpkin-plugins/build'
    };
    const plan = (files, exists = () => true) => planChecks(files, exists, (dir) => names[dir]);
    const turbo = (steps) => steps.find((s) => s.name === 'Typecheck and unit tests')?.args;

    it('lints the changed files and checks their package', () => {
        const steps = plan(['packages/upnpumpkin/src/forwarder.ts', 'packages/upnpumpkin/README.md']);
        const biome = steps.find((s) => s.name === 'Biome');
        assert.equal(biome?.args.includes('--write'), false);
        assert.deepEqual(biome?.args.slice(-2), [
            'packages/upnpumpkin/src/forwarder.ts',
            'packages/upnpumpkin/README.md'
        ]);
        const jsdoc = steps.find((s) => s.name === 'JSDoc');
        assert.equal(jsdoc?.args.includes('--fix'), false);
        assert.deepEqual(jsdoc?.args.slice(-1), ['packages/upnpumpkin/src/forwarder.ts']);
        assert.ok(turbo(steps)?.includes('--filter=...@pumpkin-plugins/upnpumpkin'));
        assert.deepEqual(
            steps.slice(-2).map((s) => s.name),
            ['Repo checks', 'Generated READMEs']
        );
    });

    it('checks the dependents of a changed tool', () => {
        assert.ok(turbo(plan(['tools/config/src/load.ts']))?.includes('--filter=...@pumpkin-plugins/config'));
    });

    it('checks every package when a shared file changes', () => {
        const args = turbo(plan(['tsconfig.base.json', 'packages/upnpumpkin/src/x.ts']));
        assert.ok(args);
        assert.equal(
            args.some((a) => a.startsWith('--filter')),
            false
        );
    });

    it('runs the script tests when a script or hook changes', () => {
        assert.ok(plan(['scripts/check-docs.mjs']).some((s) => s.name === 'Script tests'));
        assert.ok(plan(['.agents/hooks/guard.mjs']).some((s) => s.name === 'Script tests'));
        assert.equal(
            plan(['docs/testing.md']).some((s) => s.name === 'Script tests'),
            false
        );
    });

    it('does not lint deleted files, and ignores build output', () => {
        const steps = plan(['packages/upnpumpkin/src/gone.ts'], () => false);
        assert.equal(
            steps.some((s) => s.name === 'Biome'),
            false
        );
        assert.ok(turbo(steps));
        assert.deepEqual(plan(['packages/upnpumpkin/build/x.wasm', 'dist/x.wasm']), []);
    });
});

describe('check scope regressions', () => {
    const names = (dir) => `@pumpkin-plugins/${dir.split('/')[1]}`;
    const plan = (files, packageName = names) => planChecks(files, () => true, packageName);
    const turbo = (steps) => steps.find((s) => s.name === 'Typecheck and unit tests')?.args;

    it('checks build-tool source but ignores its actual output directory', () => {
        assert.ok(turbo(plan(['tools/build/src/cli.ts']))?.includes('--filter=...@pumpkin-plugins/build'));
        assert.deepEqual(plan(['tools/build/build/types/api.d.ts']), []);
    });

    it('checks all packages for lockfile changes and removed packages', () => {
        for (const steps of [plan(['pnpm-lock.yaml']), plan(['tools/gone/src/index.ts'], () => undefined)]) {
            assert.ok(turbo(steps));
            assert.equal(
                turbo(steps).some((arg) => arg.startsWith('--filter=')),
                false
            );
        }
    });

    it('checks repo lint when its configuration changes, without fixes', () => {
        for (const config of ['biome.json', 'eslint.config.mjs']) {
            assert.deepEqual(plan([config])[0], { name: 'Repo lint', args: ['lint'] });
        }
    });

    it('skips package tests for markdown-only changes and deduplicates files', () => {
        assert.equal(turbo(plan(['tools/config/README.md'])), undefined);
        const steps = plan(['tools/config/src/load.ts', 'tools/config/src/load.ts']);
        assert.equal(steps[0].args.filter((f) => f === 'tools/config/src/load.ts').length, 1);
        assert.equal(
            steps.some((step) => step.args.includes('--fix') || step.args.includes('--write')),
            false
        );
    });

    it('does not report an aborted run as passing', async () => {
        await assert.rejects(runChecks([{ name: 'Must not run', args: ['test'] }], { signal: AbortSignal.abort() }), {
            name: 'AbortError'
        });
    });
});

describe('parseStatus', () => {
    it('preserves both packages in staged and unstaged renames, including unusual filenames', () => {
        assert.deepEqual(
            parseStatus(
                'R  tools/new/a.ts\0tools/old/a.ts\0 R packages/new/b.ts\0packages/old/b.ts\0?? file with space\nand newline.ts\0'
            ),
            [
                'tools/new/a.ts',
                'tools/old/a.ts',
                'packages/new/b.ts',
                'packages/old/b.ts',
                'file with space\nand newline.ts'
            ]
        );
    });

    it('keeps staged, unstaged, deleted and untracked files and deduplicates copies', () => {
        assert.deepEqual(parseStatus(' M a.ts\0D  gone.ts\0?? new.ts\0C  copy.ts\0a.ts\0'), [
            'a.ts',
            'gone.ts',
            'new.ts',
            'copy.ts'
        ]);
        assert.deepEqual(parseStatus(''), []);
    });
});
