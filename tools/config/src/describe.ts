import type { ConfigInfo, ConfigOptionInfo } from '@pumpkin-plugins/docs';
import type { Fields } from './fields.ts';
import { type RenderOptions, renderConfig } from './render.ts';
import { type ConfigSchema, defaultValues } from './schema.ts';

function optionRows(prefix: string, fields: Fields): ConfigOptionInfo[] {
    return Object.entries(fields).map(([key, f]) => ({
        key: `${prefix}.${key}`,
        type: f.type,
        ...(f.default === undefined ? {} : { default: f.format(f.default as never) }),
        description: f.description
    }));
}

/**
 * Describes a config file for the README generator: the file a fresh install gets and a table
 * of every setting. Both come from the schema, so they can't drift from what the plugin reads.
 * @param schema - The config schema.
 * @param file - The config file's name in the plugin's data folder.
 * @param renderOptions - The rendering options the plugin passes to `loadConfig`.
 * @returns The `config` section of the plugin's `info`.
 */
export function describeConfig(schema: ConfigSchema, file: string, renderOptions: RenderOptions = {}): ConfigInfo {
    const options = Object.entries(schema.nodes).flatMap(([name, node]) =>
        optionRows(node.node === 'table' ? `${name}."<${node.entryName}>"` : name, node.fields)
    );
    return { file, defaultContents: renderConfig(schema, defaultValues(schema), renderOptions), options };
}
