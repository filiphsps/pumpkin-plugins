import { Command } from 'pumpkin:plugin/command@0.1.0';
import type { Context } from 'pumpkin:plugin/context@0.1.0';
import * as logging from 'pumpkin:plugin/logging@0.1.0';
import type { PluginMetadata } from 'pumpkin:plugin/metadata@0.1.0';
import type { Server } from 'pumpkin:plugin/server@0.1.0';
import { Plugin, registerPlugin } from '@pumpkin-plugins/pumpkin-api';
import {
    API_WORKLOAD,
    measureSyntheticWorkloads,
    measureWorkload,
    PLAYER_QUERIES_PER_SAMPLE,
} from './benchmark-workloads.ts';

export * from '@pumpkin-plugins/pumpkin-api';

const EVENT_LISTENER_COUNT = 3;
const COMMAND_PERMISSION = 'RuntimeBenchmark:command.runtime-benchmark';

class RuntimeBenchmarkPlugin extends Plugin {
    private eventDispatches = 0;
    private scheduledCallbacks = 0;
    private permissionRegistrations = 0;
    private commandRegistrations = 0;
    private commandDispatches = 0;
    private reported = false;

    metadata(): PluginMetadata {
        return {
            name: 'RuntimeBenchmark',
            version: '0.0.0',
            authors: [],
            description: 'Compares runtimes on common Minecraft plugin workloads',
            dependencies: [],
            permissions: [],
        };
    }

    onLoad(context: Context): void {
        super.onLoad(context);
        for (let listener = 0; listener < EVENT_LISTENER_COUNT; listener++) {
            this.registerEvent(context, 'server-tick-end-event', (server) => {
                this.eventDispatches++;
                if (this.eventDispatches % EVENT_LISTENER_COUNT === 0) this.report(server);
            });
        }
        this.scheduleDelayedTask(1, (server) => {
            this.scheduledCallbacks++;
            this.report(server);
        });
        context.registerPermission({
            node: COMMAND_PERMISSION,
            description: 'Run runtime benchmark workloads',
            default: { tag: 'allow' },
            children: [],
        });
        this.permissionRegistrations++;
        this.registerCommand(
            context,
            new Command(['runtime-benchmark'], 'Run runtime benchmark workloads'),
            (_sender, server) => {
                this.commandDispatches++;
                this.report(server);
                return 1;
            },
            COMMAND_PERMISSION,
        );
        this.commandRegistrations++;
        logging.log('info', 'RUNTIME_BENCHMARK_READY');
    }

    private report(server: Server): void {
        if (
            this.reported ||
            this.eventDispatches < EVENT_LISTENER_COUNT ||
            this.scheduledCallbacks === 0 ||
            this.commandDispatches === 0
        ) {
            return;
        }
        this.reported = true;

        let serverQueries = 0;
        let playersObserved = 0;
        const workloads = [
            ...measureSyntheticWorkloads(),
            measureWorkload(
                API_WORKLOAD.name,
                API_WORKLOAD.area,
                'real Pumpkin API',
                API_WORKLOAD.operationsPerSample,
                () => {
                    let total = 0;
                    for (let index = 0; index < PLAYER_QUERIES_PER_SAMPLE; index++) {
                        const players = server.getAllPlayers();
                        serverQueries++;
                        playersObserved += players.length;
                        total += players.length;
                    }
                    return total;
                },
            ),
        ];

        logging.log(
            'info',
            `RUNTIME_BENCHMARK:${JSON.stringify({
                workloads,
                apiBehavior: {
                    eventRegistrations: EVENT_LISTENER_COUNT,
                    eventDispatches: this.eventDispatches,
                    scheduledTasks: 1,
                    scheduledCallbacks: this.scheduledCallbacks,
                    permissionRegistrations: this.permissionRegistrations,
                    commandRegistrations: this.commandRegistrations,
                    commandDispatches: this.commandDispatches,
                    serverQueries,
                    playersObserved,
                },
                unicodePropertyEscapes: supportsUnicodePropertyEscapes(),
                runtimeSourceCompilation: supportsRuntimeSourceCompilation(),
            })}`,
        );
    }
}

function supportsUnicodePropertyEscapes(): boolean {
    try {
        // Keep this dynamic so Hermes without the feature can catch SyntaxError instead of failing to parse the plugin.
        // biome-ignore lint/complexity/useRegexLiterals: this probes whether the selected build supports the syntax.
        return new RegExp('\\p{L}+', 'u').test('Pumpkin');
    } catch {
        return false;
    }
}

function supportsRuntimeSourceCompilation(): boolean {
    try {
        const globalEval = Reflect.get(globalThis, 'eval') as (source: string) => unknown;
        const FunctionConstructor = Reflect.get(globalThis, 'Function') as unknown as (source: string) => () => unknown;
        return globalEval('20 + 22') === 42 && FunctionConstructor('return 20 + 22')() === 42;
    } catch {
        return false;
    }
}

registerPlugin(new RuntimeBenchmarkPlugin());
