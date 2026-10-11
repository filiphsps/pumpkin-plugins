import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startPumpkin } from '@pumpkin-plugins/test-harness';
import { expect, it } from 'vitest';
import { resolveBuildTarget } from '../../../scripts/pumpkin-targets.mjs';
import { bundlePlugin } from '../../../tools/build/src/bundle.ts';

it('releases repeated world acquisitions in the bundled QuickJS runtime', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pumpkin-resource-lifetime-'));
    const { apiEntry: api, witRoot } = await resolveBuildTarget(process.cwd());
    const entry = path.join(directory, 'probe.ts');
    const output = path.join(directory, 'probe.wasm');
    const disposer = path.resolve('../../tools/plugin-kit/src/wasi-resource.ts');
    fs.writeFileSync(
        entry,
        `import { Plugin, registerPlugin } from ${JSON.stringify(api)};
import { disposeWasiResource } from ${JSON.stringify(disposer)};
import * as logging from 'pumpkin:plugin/logging@0.1.0';
class ResourceLifetimeProbe extends Plugin {
    metadata() {
        return { name: 'ResourceLifetimeProbe', version: '0.0.0', authors: [],
            description: 'World resource lifetime regression', dependencies: [], permissions: [] };
    }
    onLoad(ctx) {
        const server = ctx.getServer();
        try {
            let acquisitions = 0;
            for (let index = 0; index < 100000; index++) {
                const worlds = server.getAllWorlds();
                for (const world of worlds) {
                    const name = world.getName();
                    if (typeof world.drop !== 'function') throw new Error('Owned world cannot be disposed');
                    disposeWasiResource(world);
                    // Disposal is idempotent, and further host calls fail as catchable JS errors.
                    disposeWasiResource(world);
                    let invalidated = false;
                    try { world.getName(); } catch { invalidated = true; }
                    if (!invalidated) throw new Error('Disposed world remains usable: ' + name);
                    acquisitions++;
                }
            }
            logging.log('info', 'ResourceLifetimeProbe: released ' + acquisitions + ' worlds');
        } finally {
            disposeWasiResource(server);
        }
    }
}
registerPlugin(new ResourceLifetimeProbe());
export * from ${JSON.stringify(api)};
`
    );
    try {
        await bundlePlugin({
            entry,
            output,
            witDir: witRoot,
            apiEntry: api,
            version: '0.0.0'
        });
        const server = await startPumpkin({ name: 'resource-lifetime', plugins: [output] });
        try {
            expect(server.errors()).toEqual([]);
            await server.waitForLog(/ResourceLifetimeProbe: released 300000 worlds/);
            expect(server.errors()).toEqual([]);
        } finally {
            await server.stop();
        }
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
