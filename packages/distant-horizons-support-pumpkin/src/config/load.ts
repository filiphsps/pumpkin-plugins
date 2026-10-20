import { loadConfig } from '@pumpkin-plugins/config';
import type { DataFiles } from '@pumpkin-plugins/plugin-kit/files';
import type { Logger } from '@pumpkin-plugins/plugin-kit/logger';
import { strFromU8, strToU8 } from 'fflate';
import { renderOptions, type Settings, schema } from './schema.ts';

/** Loads and documents settings; invalid syntax aborts startup without overwriting the file. */
export function readSettings(files: DataFiles, log: Logger): Settings {
    const result = loadConfig(
        schema,
        {
            read: () => (files.stat('config.toml') ? strFromU8(files.readFile('config.toml')) : undefined),
            write: (text) => files.writeFile('config.toml', strToU8(text)),
        },
        renderOptions,
    );
    for (const warning of result.warnings) log.warn(warning);
    return { ...result.values.support, worlds: result.values.worlds };
}
