import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'vitest';

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runtimeShim = path.join(packageRoot, 'src/component/templates/runtime-shim.template');
const dispatchFixture = path.join(packageRoot, 'test/fixtures/callback-dispatch.cpp');
const directories = [];

function compileAndRun(source) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-callback-drops-'));
    directories.push(root);
    const input = path.join(root, 'callback-resource-drops.cpp');
    const executable = path.join(root, 'callback-resource-drops');
    fs.writeFileSync(input, source);
    childProcess.execFileSync(process.env.CXX ?? 'c++', ['-std=c++17', input, '-o', executable], {
        stdio: 'pipe',
    });
    childProcess.execFileSync(executable, [], { stdio: 'pipe' });
}

function generatedCallbacks(source) {
    const firstCallback = source.indexOf('bool exports_plugin_handle_ai_goal_can_start(');
    const helper = source.indexOf('static std::shared_ptr<ResourceState> makeOwnedWitCallbackResource(');
    const start = helper >= 0 ? helper : firstCallback;
    const end = source.indexOf('void exports_pumpkin_plugin_metadata_get_metadata(');
    if (start < 0 || end <= start) {
        throw new Error('Unable to find callback exports in the runtime shim');
    }
    return source.slice(start, end);
}

afterEach(() => {
    for (const directory of directories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe('callback dispatch and resource ownership', () => {
    it('dispatches registered AI goals and chunk generators through their callback exports', () => {
        const source = fs.readFileSync(dispatchFixture, 'utf8');
        const marker = '/* GENERATED_CALLBACKS */';
        if (!source.includes(marker)) {
            throw new Error('Callback fixture is missing its generated-code marker');
        }
        const callbacks = generatedCallbacks(fs.readFileSync(runtimeShim, 'utf8'));
        compileAndRun(source.replace(marker, callbacks));
    });
});
