import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { HookScope, snapshotWorkingTree } from './scope.mjs';

const temporaryDirectories = [];

function temporaryDirectory() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pumpkin-hook-scope-test-'));
    temporaryDirectories.push(directory);
    return directory;
}

after(() => {
    for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true });
});

describe('Codex hook scope', () => {
    it('records only working-tree changes made during a tool call', () => {
        const directory = temporaryDirectory();
        let current = new Map([['other-agent.ts', 'already-dirty']]);
        const scope = new HookScope({ directory, snapshot: () => new Map(current) });
        const request = {
            session_id: 'session-a',
            turn_id: 'turn-a',
            tool_use_id: 'tool-a',
            tool_name: 'apply_patch',
            tool_input: { command: '*** Begin Patch\n*** Update File: packages/p/src/current.ts\n*** End Patch' },
        };

        scope.beforeTool(request);
        current = new Map([
            ['other-agent.ts', 'changed by a concurrent agent'],
            ['packages/p/src/current.ts', 'changed'],
        ]);
        scope.afterTool(request);

        assert.deepEqual(scope.files('session-a', 'turn-a'), ['packages/p/src/current.ts']);
        assert.deepEqual(scope.files('session-a', 'turn-b'), []);
        assert.deepEqual(scope.files('session-b', 'turn-a'), []);
    });

    it('does not claim unrelated changes during a shell command without an output target', () => {
        const directory = temporaryDirectory();
        let current = new Map();
        const scope = new HookScope({ directory, snapshot: () => new Map(current) });
        const request = {
            session_id: 'session-a',
            turn_id: 'turn-a',
            tool_use_id: 'tool-a',
            tool_name: 'Bash',
            tool_input: { command: 'pnpm test:scripts' },
        };

        scope.beforeTool(request);
        current = new Map([['other-session.ts', 'changed concurrently']]);
        scope.afterTool(request);

        assert.deepEqual(scope.files('session-a', 'turn-a'), []);
    });

    it('does not scan the working tree for a tool call without file targets', () => {
        const scope = new HookScope({
            directory: temporaryDirectory(),
            snapshot: () => assert.fail('must not scan the working tree'),
        });
        const request = {
            session_id: 'session-a',
            turn_id: 'turn-a',
            tool_use_id: 'tool-a',
            tool_name: 'Bash',
            tool_input: { command: 'pnpm test:scripts' },
        };

        scope.beforeTool(request);
        scope.afterTool(request);

        assert.deepEqual(scope.files('session-a', 'turn-a'), []);
    });

    it('limits shell output changes to the file targeted by the command', () => {
        const directory = temporaryDirectory();
        let current = new Map();
        const scope = new HookScope({ directory, snapshot: () => new Map(current) });
        const request = {
            session_id: 'session-a',
            turn_id: 'turn-a',
            tool_use_id: 'tool-a',
            tool_name: 'Bash',
            tool_input: { command: 'cat > packages/p/src/current.ts' },
        };

        scope.beforeTool(request);
        current = new Map([
            ['other-session.ts', 'changed concurrently'],
            ['packages/p/src/current.ts', 'written by this command'],
        ]);
        scope.afterTool(request);

        assert.deepEqual(scope.files('session-a', 'turn-a'), ['packages/p/src/current.ts']);
    });

    it('detects edits to files that were already dirty before the tool call', () => {
        const directory = temporaryDirectory();
        let current = new Map([['packages/p/src/shared.ts', 'previous edit']]);
        const scope = new HookScope({ directory, snapshot: () => new Map(current) });
        const request = {
            session_id: 'session-a',
            turn_id: 'turn-a',
            tool_use_id: 'tool-a',
            tool_name: 'apply_patch',
            tool_input: { command: '*** Begin Patch\n*** Update File: packages/p/src/shared.ts\n*** End Patch' },
        };

        scope.beforeTool(request);
        current = new Map([['packages/p/src/shared.ts', 'this turn edit']]);
        scope.afterTool(request);

        assert.deepEqual(scope.files('session-a', 'turn-a'), ['packages/p/src/shared.ts']);
    });

    it('keeps a failed check scope for one retry without sharing subagent checkpoints', () => {
        const directory = temporaryDirectory();
        const scope = new HookScope({ directory, snapshot: () => new Map() });
        const rootStop = {
            hook_event_name: 'Stop',
            session_id: 'session-a',
            turn_id: 'root-turn',
            stop_hook_active: false,
        };
        const subagentStop = {
            hook_event_name: 'SubagentStop',
            session_id: 'session-a',
            turn_id: 'agent-turn',
            agent_id: 'agent-a',
            stop_hook_active: false,
        };

        scope.finish(rootStop, ['packages/p/src/root.ts'], false);
        scope.finish(subagentStop, ['tools/config/src/agent.ts'], false);

        assert.deepEqual(scope.files('session-a', 'root-retry', { retrying: true, identity: 'root' }), [
            'packages/p/src/root.ts',
        ]);
        assert.deepEqual(scope.files('session-a', 'agent-retry', { retrying: true, identity: 'subagent:agent-a' }), [
            'tools/config/src/agent.ts',
        ]);

        scope.finish({ ...rootStop, turn_id: 'root-retry', stop_hook_active: true }, ['packages/p/src/root.ts'], true);
        assert.deepEqual(scope.files('session-a', 'later-turn', { retrying: true, identity: 'root' }), []);
    });

    it('captures tracked and untracked files from git status', () => {
        const directory = temporaryDirectory();
        const git = (args) => {
            const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
            assert.equal(result.status, 0, result.stderr);
        };
        fs.writeFileSync(path.join(directory, 'tracked.ts'), 'initial');
        git(['init', '--quiet']);
        git(['add', 'tracked.ts']);
        git([
            '-c',
            'user.name=Hook Test',
            '-c',
            'user.email=hook-test@example.invalid',
            'commit',
            '--quiet',
            '-m',
            'initial',
        ]);

        fs.writeFileSync(path.join(directory, 'tracked.ts'), 'updated');
        fs.writeFileSync(path.join(directory, 'untracked file.ts'), 'new');

        assert.deepEqual([...snapshotWorkingTree(directory).keys()].sort(), ['tracked.ts', 'untracked file.ts']);
        assert.deepEqual([...snapshotWorkingTree(directory, ['untracked file.ts']).keys()], ['untracked file.ts']);
        assert.deepEqual([...snapshotWorkingTree(directory, []).keys()], []);
    });
});
