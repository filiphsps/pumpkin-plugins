import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runtimeShim = path.join(packageRoot, 'src/component/templates/runtime-shim.template');
const fixtures = path.join(packageRoot, 'test/fixtures');
const dispatchFixture = path.join(fixtures, 'callback-dispatch.cpp');
const directories = [];

function compileAndRun(source) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-callback-drops-'));
    directories.push(root);
    const input = path.join(root, 'callback-resource-drops.cpp');
    const executable = path.join(root, 'callback-resource-drops');
    fs.writeFileSync(input, source);
    childProcess.execFileSync(process.env.CXX ?? 'c++', ['-std=c++17', '-I', fixtures, input, '-o', executable], {
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

function templateFunction(source, signature) {
    const start = source.indexOf(signature);
    if (start < 0) throw new Error(`Unable to find ${signature} in the runtime shim`);
    let depth = 0;
    for (let index = source.indexOf('{', start); index < source.length; index++) {
        if (source[index] === '{') depth++;
        if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
    }
    throw new Error(`Unclosed body for ${signature} in the runtime shim`);
}

function compileFixture(filename, blocks) {
    let source = fs.readFileSync(path.join(fixtures, filename), 'utf8');
    for (const [marker, block] of Object.entries(blocks)) {
        if (source.split(marker).length !== 2) throw new Error(`${filename} must contain exactly one ${marker}`);
        source = source.replace(marker, block);
    }
    compileAndRun(source);
}

afterEach(() => {
    for (const directory of directories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe('callback dispatch and resource ownership', () => {
    it('gives the C++ fixtures the scope guard the runtime shim ships', () => {
        const guard = (source) => templateFunction(source, 'template <typename Callback> class WitScopeGuard final');
        const support = fs.readFileSync(path.join(fixtures, 'runtime-contract-support.hpp'), 'utf8');
        expect(guard(support)).toBe(guard(fs.readFileSync(runtimeShim, 'utf8')));
    });

    it('dispatches registered AI goals and chunk generators through their callback exports', () => {
        const source = fs.readFileSync(dispatchFixture, 'utf8');
        const marker = '/* GENERATED_CALLBACKS */';
        if (!source.includes(marker)) {
            throw new Error('Callback fixture is missing its generated-code marker');
        }
        const callbacks = generatedCallbacks(fs.readFileSync(runtimeShim, 'utf8'));
        compileAndRun(source.replace(marker, callbacks));
    });

    it('rejects a plain object where a resource is expected', () => {
        const shim = fs.readFileSync(runtimeShim, 'utf8');
        compileFixture('native-resource.cpp', {
            '/* GENERATED_NATIVE_RESOURCE */': templateFunction(shim, 'std::shared_ptr<HostObject> nativeResource('),
        });
    });

    it('unloads a plugin without a runtime and survives any exception from onUnload', () => {
        const shim = fs.readFileSync(runtimeShim, 'utf8');
        compileFixture('plugin-on-unload.cpp', {
            '/* GENERATED_PLUGIN_ON_UNLOAD */': templateFunction(shim, 'bool exports_plugin_on_unload('),
        });
    });

    it('frees the sender and message an IPC callback receives', () => {
        const shim = fs.readFileSync(runtimeShim, 'utf8');
        compileFixture('ipc-message.cpp', {
            '/* GENERATED_HANDLE_IPC_MESSAGE */': templateFunction(shim, 'bool exports_plugin_handle_ipc_message('),
        });
    });
});
