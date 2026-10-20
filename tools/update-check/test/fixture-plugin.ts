import { Command, CommandNode, type CommandSender, type ConsumedArgs } from 'pumpkin:plugin/command@0.1.0';
import type { Context } from 'pumpkin:plugin/context@0.1.0';
import { log } from 'pumpkin:plugin/logging@0.1.0';
import type { PluginMetadata } from 'pumpkin:plugin/metadata@0.1.0';
import { scheduleDelayedTask } from 'pumpkin:plugin/scheduler@0.1.0';
import type { Server } from 'pumpkin:plugin/server@0.1.0';
import { getDirectories } from 'wasi:filesystem/preopens@0.2.3';
import { handleCommand as apiHandleCommand, handleTask as apiHandleTask, Plugin } from '@pumpkin-plugins/pumpkin-api';
import { strFromU8 } from 'fflate';
import { registerPluginWithUpdates, requestMarketJsonAsync, type UpdateRegistrationOptions } from '../src/index.ts';

/** File in the plugin's data folder that holds the test Market base URL. */
const MARKET_URL_FILE = 'market-url.txt';

const updateOptions: UpdateRegistrationOptions = { schedule };

/** A real Pumpkin plugin that runs the scheduled update check against a test Market. */
class UpdateCheckFixture extends Plugin {
    onLoad(ctx: Context): void {
        updateOptions.marketplaceUrl = readMarketUrl();
        const command = new Command(['checkhttp'], 'Run the fixture HTTP request.');
        const url = CommandNode.argument('url', { tag: 'string', val: 'greedy' });
        url.executeWithHandlerId(800_000);
        command.then(url);
        ctx.registerCommand(command, '');
    }

    metadata(): PluginMetadata {
        return {
            name: 'UpdateCheckFixture',
            version: __PLUGIN_VERSION__,
            authors: [],
            description: 'Exercises update checking inside a Pumpkin plugin.',
            dependencies: [],
            permissions: ['http.outbound', 'fs.read.data'],
        };
    }
}

registerPluginWithUpdates(
    new UpdateCheckFixture(),
    {
        name: 'UpdateCheckFixture',
        description: 'Exercises automatic update checking inside a Pumpkin plugin.',
        permissions: [
            { name: 'http.outbound', reason: 'Check for updates.' },
            { name: 'fs.read.data', reason: 'Read the test Market URL.' },
        ],
    },
    updateOptions,
);

export * from '@pumpkin-plugins/pumpkin-api';

const tasks = new Map<number, () => void>();
let nextTask = 800_000;
function schedule(callback: () => void): void {
    const id = nextTask++;
    tasks.set(id, callback);
    scheduleDelayedTask(id, 1n);
}

/** Dispatches the fixture's deferred HTTP polls. */
export function handleTask(id: number, server: Server): void {
    const callback = tasks.get(id);
    if (!callback) {
        apiHandleTask(id, server);
        return;
    }
    tasks.delete(id);
    callback();
}

/** Starts a real WASI request to the local test HTTP server. */
export function handleCommand(id: number, sender: CommandSender, server: Server, args: ConsumedArgs): number {
    if (id !== 800_000) return apiHandleCommand(id, sender, server, args);
    const url = args.getValue('url');
    if (url.tag !== 'simple') throw new Error('Expected a URL');
    requestMarketJsonAsync(url.val, schedule, (result) => {
        log('info', `Fixture HTTP result: ${result.ok ? JSON.stringify(result.value) : String(result.error)}`);
    });
    log('info', 'Fixture HTTP request scheduled');
    return 1;
}

// The tests seed this file so the check never reaches the real Market.
function readMarketUrl(): string {
    const mounts = getDirectories();
    try {
        const data = mounts.find(([, path]) => path === 'data')?.[0];
        if (!data) throw new Error('The data folder is not mounted');
        const file = data.openAt({}, MARKET_URL_FILE, {}, { read: true });
        try {
            return strFromU8(file.read(4096n, 0n)[0]).trim();
        } finally {
            release(file);
        }
    } finally {
        for (const [descriptor] of mounts) release(descriptor);
    }
}

// Static Hermes resources without a host `drop` have no dispose method.
function release(resource: { [Symbol.dispose]?: () => void; drop?: () => void }): void {
    (resource[Symbol.dispose] ?? resource.drop)?.call(resource);
}
