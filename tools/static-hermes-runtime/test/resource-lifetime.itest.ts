import { startPumpkin } from '@pumpkin-plugins/test-harness';
import { expect, it } from 'vitest';
import { buildProbePlugin, saveEvidence } from './fixtures/probe-plugin.ts';

const source = /* TypeScript */ `
import type { Context } from 'pumpkin:plugin/context@0.1.0';
import * as logging from 'pumpkin:plugin/logging@0.1.0';
import { disposeWasiResource } from '@pumpkin-plugins/plugin-kit/wasi-resource';
import { Plugin, registerPlugin } from '@pumpkin-plugins/pumpkin-api';

class ResourceLifetimeProbe extends Plugin {
    metadata() {
        return { name: 'ResourceLifetimeProbe', version: '0.0.0', authors: [],
            description: 'World resource lifetime regression', dependencies: [], permissions: [] };
    }
    onLoad(ctx: Context) {
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
export * from '@pumpkin-plugins/pumpkin-api';
`;

it('releases repeated world acquisitions in the Static Hermes Runtime', async () => {
    const probe = buildProbePlugin('resource-lifetime', source);
    const server = await startPumpkin({ name: 'static-hermes-resource-lifetime', plugins: [probe.wasm] });
    try {
        await server.waitForLog(/ResourceLifetimeProbe: released 300000 worlds/);
        expect(server.errors()).toEqual([]);
    } finally {
        saveEvidence(probe, 'resource-lifetime', server.lines);
        await server.stop();
    }
}, 300_000);
