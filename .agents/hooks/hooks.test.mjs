// Tests for the agent hooks. Run with `pnpm test:scripts`.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planChecks } from './check.mjs';
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

    it('refuses skipping hooks and force-pushing', () => {
        assert.match(checkShell('git commit --no-verify -m "x"') ?? '', /--no-verify/);
        assert.match(checkShell('git push --force origin feat') ?? '', /force-push/);
        assert.match(checkShell('git push -f') ?? '', /force-push/);
        assert.match(checkShell('git push --force-with-lease') ?? '', /force-push/);
        assert.equal(checkShell('git push origin feat'), undefined);
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
            'dist/p.wasm',
            '.cache/pumpkin/x',
            'tools/config/node_modules/x/index.js',
            'packages/p/CHANGELOG.md',
            '.release-please-manifest.json'
        ]) {
            assert.ok(checkEdit(file, {}, read), file);
        }
        assert.equal(checkEdit('packages/p/src/build.ts', {}, read), undefined);
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
            quietTurbo('pnpm exec turbo run build --filter=@pumpkin-plugins/upnpumpkin'),
            'pnpm exec turbo run build --filter=@pumpkin-plugins/upnpumpkin --output-logs=errors-only'
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
        'tools/config': '@pumpkin-plugins/config'
    };
    const plan = (files, exists = () => true) => planChecks(files, exists, (dir) => names[dir]);
    const turbo = (steps) => steps.find((s) => s.name === 'Typecheck and unit tests')?.args;

    it('lints the changed files and checks their package', () => {
        const steps = plan(['packages/upnpumpkin/src/forwarder.ts', 'packages/upnpumpkin/README.md']);
        assert.deepEqual(steps.find((s) => s.name === 'Biome')?.args.slice(-2), [
            'packages/upnpumpkin/src/forwarder.ts',
            'packages/upnpumpkin/README.md'
        ]);
        assert.deepEqual(steps.find((s) => s.name === 'JSDoc lint')?.args.slice(-1), [
            'packages/upnpumpkin/src/forwarder.ts'
        ]);
        assert.ok(turbo(steps)?.includes('--filter=@pumpkin-plugins/upnpumpkin'));
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
