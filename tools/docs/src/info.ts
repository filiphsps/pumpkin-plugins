// Pure data and helpers shared by the plugin runtime and the README generator. Keep this
// file free of Pumpkin and WASI imports so Node can load it directly.
import type { CommandPermissionDefault } from './commands.ts';
import type { PumpkinPermission } from './permissions.ts';

export type {
    CommandArgumentSpec,
    CommandArgumentValue,
    CommandArgumentValues,
    CommandPath,
    CommandPermissionDefault,
    CommandPermissionInfo,
    CommandPlayerReference,
    CommandSpec,
    CommandTree,
    FlatCommand,
    SubcommandSpec,
    SubcommandTree,
} from './commands.ts';
export {
    CommandFailed,
    type CommandHandler,
    type CommandHandlers,
    type CommandLine,
    commandInfos,
    commandPermissionInfos,
    defineCommands,
    errorLine,
    flattenCommands,
} from './commands.ts';
export { code, table } from './markdown.ts';
export { isPumpkinPermission, PUMPKIN_PERMISSIONS, type PumpkinPermission } from './permissions.ts';

/** A permission the plugin asks the server for. */
export interface PermissionInfo<Name extends string = PumpkinPermission> {
    /** Pumpkin permission name, e.g. `fs.read.data`. A name Pumpkin doesn't know is a compile error. */
    name: Name;
    /** Why the plugin needs it, shown in the README. */
    reason: string;
}

/** A command the plugin lists in its README. Build these with `commandInfos` rather than writing them. */
export interface CommandInfo<Node extends string = string> {
    /** Who may run the command by default. */
    defaultPermission?: CommandPermissionDefault;
    description: string;
    /** Permission node required to run it, if any. */
    permission?: Node;
    /** Full usage as typed in game or console, e.g. `/baddon reload`. */
    usage: string;
}

/** One setting of the plugin's config file, as a row of the README table. */
export interface ConfigOptionInfo {
    /** Shown as written; omit for options without a default. */
    default?: string;
    description: string;
    /** Dotted TOML key, e.g. `web.port`. */
    key: string;
    /** TOML value shape shown in the README, such as `table[]` for an array of inline tables. */
    type: 'boolean' | 'integer' | 'string' | 'string[]' | 'table' | 'table[]';
}

/** The plugin's config file, for its README. */
export interface ConfigInfo {
    /** Exactly what the plugin writes on first start, so the README shows the real defaults. */
    defaultContents: string;
    /** File name inside the plugin's data folder. */
    file: string;
    options?: ConfigOptionInfo[];
}

/** What a plugin says about itself. One object feeds both the plugin's Pumpkin metadata and its generated README. */
export interface PluginInfo<Name extends string = string> {
    authors?: string[];
    /**
     * More generated README blocks, by name: the markdown goes between `<!-- docs:begin NAME -->` and
     * `<!-- docs:end NAME -->`. For content that comes from the plugin's code, such as a list of
     * routers it refuses. A name the README doesn't have markers for is skipped, and the built-in
     * names (`summary`, `permissions`, `commands`, `config`, `installation`) are taken.
     */
    blocks?: Readonly<Record<string, string>>;
    /** The commands, normally `commandInfos(commands)` of the tree that registers them. */
    commands?: readonly CommandInfo<`${Name}:${string}`>[];
    config?: ConfigInfo;
    description: string;
    /** Pumpkin plugin name. Also the data folder name: `plugins/data/<name>/`. */
    name: Name;
    /** The Pumpkin permissions the plugin asks for. */
    permissions?: readonly PermissionInfo[];
}

/** Permission required by the automatic Pumpkin Market update check. */
export const UPDATE_CHECK_PERMISSION: PermissionInfo<'http.outbound'> = {
    name: 'http.outbound',
    reason: 'Check Pumpkin Market for plugin updates.',
};

/** Lists declared permissions plus the one required for the automatic update check. */
export function pluginPermissions(info: Pick<PluginInfo, 'permissions'>): PermissionInfo[] {
    const permissions = [...(info.permissions ?? [])];
    if (!permissions.some((permission) => permission.name === UPDATE_CHECK_PERMISSION.name)) {
        permissions.push(UPDATE_CHECK_PERMISSION);
    }
    return permissions;
}

/** Pumpkin's `plugin-metadata` for a plugin, from its info and package version. */
export function pluginMetadata(info: PluginInfo, version: string) {
    return {
        name: info.name,
        version,
        authors: info.authors ?? [],
        description: info.description,
        dependencies: [] as string[],
        permissions: pluginPermissions(info).map((p) => p.name),
    };
}
