import { createRequire } from 'node:module';
import * as path from 'node:path';
import { ensurePumpkinWit } from '@pumpkin-plugins/pumpkin-api/wit';
import { cacheDir } from '../../build/src/repo.ts';
import { ensureWasiWit } from '../../build/src/wasi-wit.ts';
import { setupHermesToolchainEnvironment } from '../src/hermes/toolchain-environment.ts';

/**
 * Resolve the pinned Pumpkin WIT, the pinned WASI WIT and wasm-tools once, before the test workers
 * start. On a cold cache each one is a download, which can take longer than a test or hook timeout
 * on a CI runner. The esbuild plugin and the `codegen` command find wasm-tools in the same cache.
 */
export default async function setup(project) {
    // Make Git give up on a fetch that stalls for 30 s, instead of waiting for the CI job timeout.
    process.env.GIT_HTTP_LOW_SPEED_LIMIT ??= '1';
    process.env.GIT_HTTP_LOW_SPEED_TIME ??= '30';
    const workspaceRoot = path.resolve(import.meta.dirname, '../../..');
    const apiRoot = path.dirname(createRequire(import.meta.url).resolve('@pumpkin-plugins/pumpkin-api/package.json'));
    project.provide(
        'pumpkinWitDir',
        ensurePumpkinWit({ lockFile: path.join(apiRoot, 'wit.lock.json'), cacheRoot: cacheDir(workspaceRoot) }),
    );
    project.provide('wasiWitDir', await ensureWasiWit({ cacheDir: cacheDir(workspaceRoot) }));
    const toolchain = await setupHermesToolchainEnvironment({
        workspaceRoot,
        includeWasiSdk: false,
        includeWitBindgen: false,
        includeWasmTools: true,
    });
    project.provide('wasmTools', toolchain.WASM_TOOLS);
}
