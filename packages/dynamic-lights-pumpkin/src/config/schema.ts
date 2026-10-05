import { bool, type ConfigValues, defineConfig, describeConfig, int, section, table } from '@pumpkin-plugins/config';

/** Name of the settings file in the plugin data directory. */
export const CONFIG_FILE = 'config.toml';

/** Light sources included in the first generated configuration file. */
export const DEFAULT_SOURCES = {
    'minecraft:torch': { light_level: 14 },
    'minecraft:soul_torch': { light_level: 10 },
    'minecraft:redstone_torch': { light_level: 7 },
    'minecraft:lantern': { light_level: 15 },
    'minecraft:soul_lantern': { light_level: 10 },
    'minecraft:glowstone': { light_level: 15 },
    'minecraft:sea_lantern': { light_level: 15 },
    'minecraft:shroomlight': { light_level: 15 },
    'minecraft:ochre_froglight': { light_level: 15 },
    'minecraft:verdant_froglight': { light_level: 15 },
    'minecraft:pearlescent_froglight': { light_level: 15 },
    'minecraft:end_rod': { light_level: 14 },
    'minecraft:jack_o_lantern': { light_level: 15 },
    'minecraft:magma_block': { light_level: 3 },
    'minecraft:campfire': { light_level: 15 },
    'minecraft:soul_campfire': { light_level: 10 },
    'minecraft:lava_bucket': { light_level: 15 },
    'minecraft:blaze_rod': { light_level: 10 },
    'minecraft:blaze_powder': { light_level: 10 },
    'minecraft:fire_charge': { light_level: 15 },
    'minecraft:glow_ink_sac': { light_level: 8 },
    'minecraft:glowstone_dust': { light_level: 8 },
    'minecraft:magma_cream': { light_level: 8 }
};

/** Entity light sources included in the first generated configuration file. */
export const DEFAULT_ENTITY_SOURCES = {
    blaze: { light_level: 15 },
    'magma-cube': { light_level: 8 },
    'glow-squid': { light_level: 8 }
};

/** Every user-configurable dynamic-light source. */
export const configSchema = defineConfig('DynamicLightsPumpkin', {
    sources: table({
        description:
            'Per-item light levels for held sources, including items that are not blocks such as lava buckets. Set a level to 0 to disable a source.',
        entryName: 'item',
        exampleKey: 'minecraft:lava_bucket',
        defaults: DEFAULT_SOURCES,
        fields: {
            light_level: int({
                description: 'Light emitted while this item is held, from 0 through 15.',
                example: 15,
                min: 0,
                max: 15
            })
        }
    }),
    entities: section({
        description: 'Controls the optional dynamic lights shown around configured entity types.',
        fields: {
            enabled: bool({
                description: 'Whether configured entities emit temporary client-only light.',
                default: true
            }),
            refresh_interval_ticks: int({
                description:
                    'Ticks between nearby-entity refreshes. Higher values reduce work but make moving lights less smooth.',
                default: 10,
                min: 1,
                max: 1200
            })
        }
    }),
    entity_sources: table({
        description:
            'Per-entity-type light levels. Entity type names use Pumpkin names such as blaze, magma-cube and glow-squid.',
        entryName: 'entity type',
        exampleKey: 'blaze',
        defaults: DEFAULT_ENTITY_SOURCES,
        fields: {
            light_level: int({
                description: 'Light emitted by this entity type, from 0 through 15.',
                example: 15,
                min: 0,
                max: 15
            })
        }
    })
});

/** Settings inferred from the plugin's configuration schema. */
export type Config = ConfigValues<typeof configSchema>;

/** The generated README documentation for the plugin settings. */
export const configInfo = describeConfig(configSchema, CONFIG_FILE);
