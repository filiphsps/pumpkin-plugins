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
        config: renderConfig(info),
    };
}

/** How a plugin reaches servers, for the `installation` block of its README. */
export interface PluginRelease {
    /** WebAssembly file the build writes, relative to the plugin folder, such as `build/demo.wasm`. */
    output: string;
    /** npm package name, used in the build command of an unreleased plugin. */
    packageName: string;
    /** Why the plugin has no release yet. Omit it for a released plugin. */
    unreleasedReason?: string;
}

/**
 * Every generated block of a plugin README: the built-in sections and the plugin's own `blocks`.
 * @param info - What the plugin says about itself.
 * @param release - Adds the `installation` block when given.
 * @throws When a plugin block uses the name of a built-in section.
 */
export function renderBlocks(info: PluginInfo, release?: PluginRelease): Record<string, string> {
    const own = info.blocks ?? {};
    const taken = [...SECTIONS, 'installation'].find((name) => name in own);
    if (taken) throw new Error(`${info.name}: the block name "${taken}" is built in, so info.blocks cannot use it`);
    return { ...renderSections(info), ...(release ? { installation: renderInstallation(info, release) } : {}), ...own };
}

function renderInstallation({ name }: PluginInfo, { output, packageName, unreleasedReason }: PluginRelease): string {
    const file = code(output.split('/').at(-1) ?? output);
    if (unreleasedReason === undefined) {
        return `Download ${file} from the plugin's GitHub release, put it in your server's ${code('plugins/')} folder, and restart Pumpkin. On the first load, a full restart lets Pumpkin ask for the plugin's permissions; hot reload cannot prompt for them.`;
    }
    return `${name} hasn't been released yet, so there is no ${file} to download. ${unreleasedReason} To try it, clone this repository, run ${code(`pnpm build --filter ${packageName}`)}, copy ${code(output)} from the plugin's folder to your server's ${code('plugins/')} folder, and restart Pumpkin.`;
}

function renderPermissions(info: PluginInfo): string {
    const permissions = pluginPermissions(info);
    return [
        'Pumpkin asks you to approve these on the server console when it loads the plugin. It skips the question when the `[plugins]` table in `pumpkin.toml` lists all of them in `allowed_permissions` or sets `ask_permission_confirmation = false`. Pumpkin remembers your answer and asks again after the plugin file or this list changes.',
        '',
        table(
            ['Permission', 'Why'],
            permissions.map((p) => [code(p.name), p.reason]),
        ),
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
            renderCommandPermissionDefault(c.defaultPermission),
        ]),
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
        `Settings live in ${code(`plugins/data/${name}/${config.file}`)}. The plugin creates the file if needed, adds settings from the schema and removes settings no longer defined there. Values for existing settings are preserved.`,
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
                          o.description,
                      ]),
                  ),
              ]),
        '',
        '<details>',
        '<summary>A fresh install gets this file:</summary>',
        '',
        '```toml',
        config.defaultContents.replace(/\n+$/, ''),
        '```',
        '</details>',
    ].join('\n');
}
