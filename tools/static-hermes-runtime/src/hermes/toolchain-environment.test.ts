import * as path from 'node:path';
import { expect, it } from 'vitest';
import { setupHermesToolchainEnvironment } from './toolchain-environment.ts';

it('loads the package pins and resolves only the requested workspace cache', async () => {
    const workspaceRoot = path.resolve('/tmp/static-hermes-toolchain-test');

    const environment = await setupHermesToolchainEnvironment({
        workspaceRoot,
        env: {},
        includeWasiSdk: false,
        includeWitBindgen: false,
        includeWasmTools: false
    });

    expect(environment).toEqual({ STATIC_HERMES_CACHE_DIR: path.join(workspaceRoot, '.cache/hermes') });
});
