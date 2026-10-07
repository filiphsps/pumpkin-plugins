import {
    bool,
    type ConfigValues,
    defineConfig,
    describeConfig,
    type Field,
    field,
    int,
    section,
    str,
    table
} from '@pumpkin-plugins/config';
import { PLUGIN_NAME } from '../name.ts';

/** Settings for bounded LOD requests and the identity announced to DH clients. */
export const schema = defineConfig(PLUGIN_NAME, {
    support: section({
        description: 'Distant Horizons Support limits.',
        fields: {
            server_key: str({
                description: 'Optional globally unique server key. Empty uses the client connection address.',
                default: '',
                check: {
                    test: (value) => value === '' || /^[a-zA-Z0-9_-]{1,128}$/.test(value),
                    expected: 'Use at most 128 letters, digits, underscores or hyphens.'
                }
            }),
            render_distance: int({
                description: 'Maximum LOD request radius in chunks, limited by the world border.',
                default: 128,
                min: 4,
                max: 4096
            }),
            generation_requests_per_second: int({
                description:
                    'Maximum terrain generation requests per second advertised to each DH client. DH uses this for pacing and concurrency; pending_requests also caps it.',
                default: 20,
                min: 1,
                max: 128
            }),
            sync_requests_per_second: int({
                description:
                    'Maximum cached LOD synchronization requests per second advertised to each DH client. DH uses this for pacing and concurrency; pending_requests also caps it.',
                default: 50,
                min: 1,
                max: 256
            }),
            requests_per_player: int({
                description:
                    'Maximum active terrain captures per player. Misses waiting for a slot and cached responses bypass this limit.',
                default: 2,
                min: 1,
                max: 16
            }),
            pending_requests: int({
                description: 'Maximum in-flight DH requests and queued responses across all players.',
                default: 16,
                min: 1,
                max: 1024
            }),
            blocks_per_tick: int({
                description:
                    'Maximum block samples per server tick across all LOD requests. Actual work adapts to server MSPT.',
                default: 8192,
                min: 64,
                max: 196_608
            }),
            packets_per_tick: int({
                description: 'Maximum transfer packets for newly captured LODs per server tick across all players.',
                default: 2,
                min: 1,
                max: 1024
            }),
            cached_requests_per_tick: int({
                description: 'Maximum cached LOD requests checked per server tick across all players.',
                default: 8,
                min: 1,
                max: 2048
            }),
            cached_packets_per_tick: int({
                description: 'Maximum transfer packets for cached LODs per server tick across all players.',
                default: 64,
                min: 1,
                max: 16_384
            }),
            memory_cache_entries: cacheLimit(
                'Maximum LOD sections cached in memory. Set to 0 to disable; any negative value means unlimited.',
                512
            ),
            disk_cache_entries: cacheLimit(
                'Maximum LOD sections cached on disk. Set to 0 to disable; any negative value means unlimited.',
                4096
            ),
            refresh_seconds: int({
                description: 'Rebuild cached sections after this age when all their chunks are loaded.',
                default: 30,
                min: 1,
                max: 3600
            })
        }
    }),
    worlds: table({
        description:
            'Per-world terrain capture settings. Vanilla dimensions use their standard heights; unknown dimensions require a height override.',
        entryName: 'world',
        exampleKey: 'world',
        fields: {
            height: int({
                description: 'World height in blocks above its minimum Y.',
                example: 384,
                min: 1,
                max: 4095
            }),
            sample_biomes_3d: bool({
                description:
                    'Sample the biome at every captured height instead of using the surface biome for the whole column. Adds one world lookup per sampled block.',
                default: false
            })
        }
    })
});
/** Typed plugin settings. */
export type Settings = ConfigValues<typeof schema>['support'] & { worlds: ConfigValues<typeof schema>['worlds'] };
/** README and default-file options, shared by the config loader. */
export const renderOptions = { note: 'Changes apply after a server restart. Invalid files are left untouched.' };
/** Generated documentation for the installed settings file. */
export const configInfo = describeConfig(schema, 'config.toml', renderOptions);

function cacheLimit(description: string, defaultValue: number) {
    const integer = int({ description, default: defaultValue });
    return field<number>({
        type: 'integer',
        description,
        default: defaultValue,
        expected: 'a whole number',
        example: defaultValue,
        migrateFrom: ['support', 'cache_entries'],
        parse: (raw) => (typeof raw === 'bigint' && raw < 0n ? { ok: true, value: -1 } : integer.parse(raw)),
        format: String
    }) as Field<number>;
}
