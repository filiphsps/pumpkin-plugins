import { type ConfigValues, defineConfig, describeConfig, int, section, str, table } from '@pumpkin-plugins/config';

/** Settings for bounded LOD requests and the identity announced to DH clients. */
export const schema = defineConfig('DistantHorizonsSupportPumpkin', {
    support: section({
        description: 'Distant Horizons support limits.',
        fields: {
            server_key: str({
                description: 'Optional globally unique server key. Empty uses the client connection address.',
                default: '',
                check: {
                    test: (value) => value === '' || /^[a-zA-Z0-9_.-]{1,128}$/.test(value),
                    expected: 'Use at most 128 letters, digits, underscores, dots or hyphens.'
                }
            }),
            render_distance: int({
                description: 'Maximum LOD request radius in chunks, limited by the world border.',
                default: 128,
                min: 4,
                max: 1024
            }),
            requests_per_player: int({
                description: 'Maximum pending requests per player.',
                default: 2,
                min: 1,
                max: 8
            }),
            pending_requests: int({
                description: 'Maximum pending requests across all players.',
                default: 16,
                min: 1,
                max: 128
            }),
            blocks_per_tick: int({
                description: 'Maximum block samples per server tick across all LOD requests.',
                default: 2048,
                min: 64,
                max: 16384
            }),
            packets_per_tick: int({
                description: 'Maximum 30 KB transfer packets sent per server tick across all players.',
                default: 2,
                min: 1,
                max: 16
            }),
            cache_entries: int({
                description: 'Maximum LOD sections cached in memory and on disk.',
                default: 128,
                min: 1,
                max: 4096
            }),
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
            'Height overrides for custom dimensions. Vanilla dimensions use their standard heights; unknown dimensions require an override.',
        entryName: 'world',
        exampleKey: 'world',
        fields: {
            height: int({ description: 'World height in blocks above its minimum Y.', example: 384, min: 1, max: 4095 })
        }
    })
});
/** Typed plugin settings. */
export type Settings = ConfigValues<typeof schema>['support'] & { worlds: ConfigValues<typeof schema>['worlds'] };
/** README and default-file options, shared by the config loader. */
export const renderOptions = { note: 'Changes apply after a server restart. Invalid files are left untouched.' };
/** Generated documentation for the installed settings file. */
export const configInfo = describeConfig(schema, 'config.toml', renderOptions);
