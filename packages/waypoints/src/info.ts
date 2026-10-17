import { commandInfos, type PluginInfo } from '@pumpkin-plugins/docs';
import { commands } from './commands/spec.ts';
import { PLUGIN_NAME } from './name.ts';
import { type PlaceholderDefinition, waypointPlaceholderDefinitions } from './placeholders/definitions.ts';

const placeholderArguments = {
    rank: '2',
    radius: '128',
    uuid: '11111111-1111-4111-8111-111111111111',
    world: 'world',
} as const satisfies Record<NonNullable<PlaceholderDefinition['argument']>, string>;

function renderPlaceholders(): string {
    const rows = waypointPlaceholderDefinitions.map(({ name, description, argument }) => {
        const suffix = argument === undefined ? '' : `:${placeholderArguments[argument]}`;
        return `| \`%waypoints_${name}${suffix}%\` | ${description} |`;
    });
    return ['| Token | Description |', '| --- | --- |', ...rows].join('\n');
}

/**
 * What the plugin is and offers. Feeds both its Pumpkin metadata and its generated README. Declare
 * commands with `defineCommands` and list them here with `commandInfos`, so they are documented from
 * what is registered (see docs/plugin-info-and-readmes.md).
 */
export const info = {
    name: PLUGIN_NAME,
    description:
        'Waypoints lets you create shared locations, control who can access each one, show them on a Java HUD, and look them up with PumpkinPIE placeholders.',
    permissions: [
        { name: 'fs.read.data', reason: 'Read the waypoint store from the plugin data folder.' },
        { name: 'fs.write.data', reason: 'Persist waypoint changes in the plugin data folder.' },
    ],
    commands: commandInfos(commands),
    blocks: { placeholders: renderPlaceholders() },
} satisfies PluginInfo<typeof PLUGIN_NAME>;
