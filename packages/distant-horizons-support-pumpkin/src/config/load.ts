import { loadConfig } from '@pumpkin-plugins/config';
import type { DataFiles } from '@pumpkin-plugins/plugin-kit/files';
import type { Logger } from '@pumpkin-plugins/plugin-kit/logger';
import { Reader, Writer } from '../protocol/bytes.ts';
import { renderOptions, type Settings, schema } from './schema.ts';

/** Loads and documents settings; invalid syntax aborts startup without overwriting the file. */
export function readSettings(files: DataFiles, log: Logger): Settings {
    const result = loadConfig(
        schema,
        {
            read: () => {
                const stat = files.stat('config.toml');
                if (!stat) return undefined;
                if (stat.size > 65535) throw new Error('config.toml is too large');
                const bytes = files.readFile('config.toml');
                return new Reader(new Writer().short(bytes.length).bytes(bytes).finish()).string();
            },
            write: (text) => files.writeFile('config.toml', new Writer().string(text).finish().subarray(2))
        },
        renderOptions
    );
    for (const warning of result.warnings) log.warn(`DistantHorizonsSupportPumpkin: ${warning}`);
    return { ...result.values.support, worlds: result.values.worlds };
}
