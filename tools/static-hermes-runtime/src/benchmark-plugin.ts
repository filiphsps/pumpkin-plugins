import type { Context } from 'pumpkin:plugin/context@0.1.0';
import * as logging from 'pumpkin:plugin/logging@0.1.0';
import type { PluginMetadata } from 'pumpkin:plugin/metadata@0.1.0';
import type { Server } from 'pumpkin:plugin/server@0.1.0';
import { Plugin, registerPlugin } from '@pumpkinmc/pumpkin-api-ts';

export * from '@pumpkinmc/pumpkin-api-ts';

const SAMPLE_COUNT = 5;
const PLAYER_QUERIES_PER_SAMPLE = 100;
const CONFIG_SOURCE = JSON.stringify({
    enabled: true,
    cache: { maxEntries: 512, ttlTicks: 1200 },
    channels: ['status', 'inventory', 'health'],
    aliases: { hp: 'health', inv: 'inventory', st: 'status' }
});

class RuntimeBenchmarkPlugin extends Plugin {
    private eventDispatches = 0;
    private scheduledCallbacks = 0;
    private reported = false;

    metadata(): PluginMetadata {
        return {
            name: 'RuntimeBenchmark',
            version: '0.0.0',
            authors: [],
            description: 'Measures JavaScript execution under Pumpkin runtimes',
            dependencies: [],
            permissions: []
        };
    }

    onLoad(context: Context): void {
        super.onLoad(context);
        this.registerEvent(context, 'server-tick-end-event', (server) => {
            this.eventDispatches++;
            this.report(server);
        });
        this.scheduleDelayedTask(1, (server) => {
            this.scheduledCallbacks++;
            this.report(server);
        });
    }

    private report(server: Server): void {
        if (this.reported || this.eventDispatches === 0 || this.scheduledCallbacks === 0) return;
        this.reported = true;

        let serverQueries = 0;
        let playersObserved = 0;
        const workloads = [
            measure('numeric', runNumeric),
            measure('config', runConfigValidation),
            measure('event-cache', runEventCache),
            measure('packet', runPacketEncoding),
            measure('objects', runObjects),
            measure('strings', runStrings),
            measure('pumpkin-api', () => {
                let total = 0;
                for (let index = 0; index < PLAYER_QUERIES_PER_SAMPLE; index++) {
                    const players = server.getAllPlayers();
                    serverQueries++;
                    playersObserved += players.length;
                    total += players.length;
                }
                return total;
            })
        ];

        logging.log(
            'info',
            `RUNTIME_BENCHMARK:${JSON.stringify({
                workloads,
                apiBehavior: {
                    eventRegistrations: 1,
                    eventDispatches: this.eventDispatches,
                    scheduledTasks: 1,
                    scheduledCallbacks: this.scheduledCallbacks,
                    serverQueries,
                    playersObserved
                },
                unicodePropertyEscapes: supportsUnicodePropertyEscapes(),
                runtimeSourceCompilation: supportsRuntimeSourceCompilation()
            })}`
        );
    }
}

function measure(name: string, run: () => number) {
    run();
    let checksum = 0;
    const samplesMs: number[] = [];
    for (let index = 0; index < SAMPLE_COUNT; index++) {
        const startedAt = Date.now();
        checksum = run();
        samplesMs.push(Date.now() - startedAt);
    }
    return { name, samplesMs, checksum };
}

function runNumeric(): number {
    let value = 1;
    for (let index = 0; index < 1_000_000; index++) {
        value = (value * 48_271 + index + 1) % 2_147_483_647;
    }
    return value + (Math.imul(0x811c9dc5, 16_777_619) >>> 0);
}

function runConfigValidation(): number {
    let checksum = 0;
    for (let index = 0; index < 1_000; index++) {
        const config = JSON.parse(CONFIG_SOURCE) as {
            enabled: boolean;
            cache: { maxEntries: number; ttlTicks: number };
            channels: string[];
            aliases: Record<string, string>;
        };
        if (!config.enabled || config.cache.maxEntries < 1 || config.cache.ttlTicks < 1) return -1;
        const aliases = new Map(Object.entries(config.aliases));
        checksum += config.channels.length + aliases.size + config.cache.maxEntries + config.cache.ttlTicks;
    }
    return checksum;
}

function runEventCache(): number {
    const cache = new Map<string, { food: number; lastTick: number }>();
    for (let tick = 0; tick < 20_000; tick++) {
        const playerId = `player-${tick % 2_000}`;
        const current = cache.get(playerId);
        cache.set(playerId, { food: current ? (current.food + 1) % 21 : tick % 21, lastTick: tick });
        if (tick % 1_000 === 999) {
            for (const [id, entry] of cache) {
                if (tick - entry.lastTick > 1_000) cache.delete(id);
            }
        }
    }
    let checksum = 0;
    for (const [id, entry] of cache) checksum += id.length + entry.food + entry.lastTick;
    return checksum;
}

function runPacketEncoding(): number {
    const payload = new Uint8Array(256);
    const view = new DataView(payload.buffer);
    let checksum = 0;
    // Model a burst of fixed-size plugin packets, rather than timing only one tiny buffer.
    for (let packet = 0; packet < 256; packet++) {
        for (let field = 0; field < 64; field++) {
            view.setUint32(field * 4, (packet * 0x9e3779b1 + field) >>> 0, false);
        }
        for (let field = 0; field < 64; field++) checksum = (checksum + view.getUint32(field * 4, false)) >>> 0;
    }
    return checksum;
}

function runObjects(): number {
    const records: { id: number; value: number }[] = [];
    for (let id = 0; id < 50_000; id++) records.push({ id, value: (id * 17) % 97 });
    let total = 0;
    for (const record of records) total = (total + record.id * record.value) >>> 0;
    return total;
}

function runStrings(): number {
    const parts = new Array<string>(25_000);
    for (let index = 0; index < parts.length; index++) {
        parts[index] = `${index.toString(36)}:${String.fromCharCode(65 + (index % 26))}`;
    }
    const joined = parts.join('|');
    return joined.length + joined.charCodeAt(joined.length - 1);
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
        const FunctionConstructor = Reflect.get(globalThis, 'Function') as (source: string) => () => unknown;
        return globalEval('20 + 22') === 42 && FunctionConstructor('return 20 + 22')() === 42;
    } catch {
        return false;
    }
}

registerPlugin(new RuntimeBenchmarkPlugin());
