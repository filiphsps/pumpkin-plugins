import { commandInfos, type PluginInfo } from '@pumpkin-plugins/docs';
import { commands } from './commands/spec.ts';
import { PLUGIN_NAME } from './name.ts';
import { type PlaceholderDefinition, waypointPlaceholderDefinitions } from './placeholders/definitions.ts';

/** Example argument for each placeholder argument kind, shown in generated token tables. */
export const placeholderArgumentExamples = {
    rank: '2',
    radius: '128',
    uuid: '11111111-1111-4111-8111-111111111111',
    world: 'world',
} as const satisfies Record<NonNullable<PlaceholderDefinition['argument']>, string>;

/** Formats a placeholder as its complete PIE token, filling any argument with its documented example. */
export function formatPlaceholderToken({ name, argument }: PlaceholderDefinition): string {
    const suffix = argument === undefined ? '' : `:${placeholderArgumentExamples[argument]}`;
    return `%waypoints_${name}${suffix}%`;
}

function renderPlaceholders(): string {
    const rows = waypointPlaceholderDefinitions.map(
        (definition) => `| \`${formatPlaceholderToken(definition)}\` | ${definition.description} |`,
    );
    return ['| Token | Description |', '| --- | --- |', ...rows].join('\n');
}

/** Waypoints metadata and README source: data-folder permissions, `/wp` commands and the PumpkinPIE token table. */
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
