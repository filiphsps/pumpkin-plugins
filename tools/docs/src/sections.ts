import type { CommandPermissionDefault } from './commands.ts';
import { type PluginInfo, pluginPermissions } from './info.ts';
import { code, table } from './markdown.ts';

/** The generated blocks of a plugin README. */
export const SECTIONS = ['summary', 'permissions', 'commands', 'config'] as const;

/** Name of one generated block. */
export type SectionName = (typeof SECTIONS)[number];

/**
 * Renders the generated blocks of a plugin README.
 * @param info - What the plugin says about itself.
 * @returns The markdown for each block, by name.
 */
export function renderSections(info: PluginInfo): Record<SectionName, string> {
    return {
        summary: info.description,
        permissions: renderPermissions(info),
        commands: renderCommands(info),
        config: renderConfig(info)
    };
}

/**
 * Every generated block of a plugin README: the built-in sections and the plugin's own `blocks`.
 * @param info - What the plugin says about itself.
 * @throws {Error} When a plugin block uses the name of a built-in section.
 */
export function renderBlocks(info: PluginInfo): Record<string, string> {
    const own = info.blocks ?? {};
    const taken = (SECTIONS as readonly string[]).find((name) => name in own);
    if (taken) throw new Error(`${info.name}: the block name "${taken}" is built in, so info.blocks cannot use it`);
    return { ...renderSections(info), ...own };
}

function renderPermissions(info: PluginInfo): string {
    const permissions = pluginPermissions(info);
    if (permissions.length === 0) return 'This plugin requests no permissions.';
    return [
        'Pumpkin asks for these on the server console the first time the plugin loads.',
        '',
        table(
            ['Permission', 'Why'],
            permissions.map((p) => [code(p.name), p.reason])
        )
    ].join('\n');
}

function renderCommands({ commands = [] }: PluginInfo): string {
    if (commands.length === 0) return 'This plugin registers no commands.';
    return table(
        ['Command', 'Description', 'Permission', 'Default access'],
        commands.map((c) => [
            code(c.usage),
            c.description,
            c.permission ? code(c.permission) : 'none',
            renderCommandPermissionDefault(c.defaultPermission)
        ])
    );
}

function renderCommandPermissionDefault(permission: CommandPermissionDefault | undefined): string {
    if (!permission) return 'operators (level 3)';
    if (permission.tag === 'allow') return 'everyone';
    if (permission.tag === 'op') {
        const level = { zero: '0', one: '1', two: '2', three: '3', four: '4' }[permission.val];
        return `operators (level ${level})`;
    }
    return 'nobody';
}

function renderConfig({ name, config }: PluginInfo): string {
    if (!config) return 'This plugin has no configuration file.';
    const options = config.options ?? [];
    return [
        `Settings live in ${code(`plugins/data/${name}/${config.file}`)}. The plugin creates the file when it is missing and keeps it in step with its settings: new options are added and removed ones dropped, and your values are kept.`,
        ...(options.length === 0
            ? []
            : [
                  '',
                  table(
                      ['Option', 'Type', 'Default', 'Description'],
                      options.map((o) => [
                          code(o.key),
                          o.type,
                          o.default === undefined ? 'none' : code(o.default),
                          o.description
                      ])
                  )
              ]),
        '',
        'A fresh install gets this file:',
        '',
        '```toml',
        config.defaultContents.replace(/\n+$/, ''),
        '```'
    ].join('\n');
}
