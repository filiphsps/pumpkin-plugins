import { Command, CommandNode, type CommandSender, type ConsumedArgs } from 'pumpkin:plugin/command@0.1.0';
import type { Context } from 'pumpkin:plugin/context@0.1.0';
import { log } from 'pumpkin:plugin/logging@0.1.0';
import type { PluginMetadata } from 'pumpkin:plugin/metadata@0.1.0';
import { scheduleDelayedTask } from 'pumpkin:plugin/scheduler@0.1.0';
import type { Server } from 'pumpkin:plugin/server@0.1.0';
import { handleCommand as apiHandleCommand, handleTask as apiHandleTask, Plugin } from '@pumpkinmc/pumpkin-api-ts';
import { registerPluginWithUpdates, requestMarketJsonAsync } from '../src/index.ts';

/** A real Pumpkin plugin that executes the update checker with a deterministic transport response. */
class UpdateCheckFixture extends Plugin {
    onLoad(ctx: Context): void {
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
            permissions: ['http.outbound']
        };
    }
}

registerPluginWithUpdates(
    new UpdateCheckFixture(),
    {
        name: 'UpdateCheckFixture',
        description: 'Exercises automatic update checking inside a Pumpkin plugin.',
        permissions: [{ name: 'http.outbound', reason: 'Check for updates.' }]
    },
    {
        request: (url) => {
            if (!url.includes('plugin_name=UpdateCheckFixture')) throw new Error('unexpected update URL');
            return { latest_version: '1.3.0', update_available: true };
        }
    }
);

export * from '@pumpkinmc/pumpkin-api-ts';

const tasks = new Map<number, () => void>();
let nextTask = 800_000;
function schedule(callback: () => void): void {
    const id = nextTask++;
    tasks.set(id, callback);
    scheduleDelayedTask(id, 1);
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
