import { type FakeRouter, routerConfig, startFakeRouter } from '@pumpkin-plugins/port-mapping/testing/router';
import { builtPluginPath, type PumpkinInstance, startPumpkin } from '@pumpkin-plugins/test-harness';
import { afterEach } from 'vitest';

/** Name the plugin gives Pumpkin, which is also its data folder name. */
export const PLUGIN_NAME = 'UPnPumpkin';

/** A Pumpkin server running the plugin, and the fake router it talks to. */
export interface Running {
    server: PumpkinInstance;
    router: FakeRouter;
}

/**
 * Call once at the top of a test file. Returns a `start` function whose servers and routers are
 * all stopped after each test.
 */
export function upnpServers() {
    const servers: PumpkinInstance[] = [];
    const routers: FakeRouter[] = [];
    afterEach(async () => {
        await Promise.all(servers.splice(0).map((s) => s.stop()));
        await Promise.all(routers.splice(0).map((r) => r.close()));
    });
    return {
        /** Starts a fake router with the given behaviour. */
        async router(options: Parameters<typeof startFakeRouter>[0] = {}): Promise<FakeRouter> {
            const router = await startFakeRouter(options);
            routers.push(router);
            return router;
        },
        /** Starts a server with the plugin and the given config. */
        async start(name: string, config: string): Promise<PumpkinInstance> {
            const server = await startPumpkin({
                name,
                plugins: [builtPluginPath(process.cwd())],
                files: { [`plugins/data/${PLUGIN_NAME}/config.toml`]: config }
            });
            servers.push(server);
            return server;
        }
    };
}

export { routerConfig };
