import { type ConfigStore, ConfigSyntaxError, defaultValues, loadConfig } from '@pumpkin-plugins/config';
import type { DataFiles } from '@pumpkin-plugins/plugin-kit/files';
import { strFromU8, strToU8 } from 'fflate';
import { CONFIG_FILE, type Config, configSchema } from './schema.ts';

/** Loads settings from the plugin data folder, leaving an invalid file untouched for the user to fix. */
export function loadPluginConfig(
    files: DataFiles,
    report: (level: 'info' | 'warn' | 'error', message: string) => void
): Config {
    try {
        const result = loadConfig(configSchema, configStore(files));
        for (const warning of result.warnings) report('warn', `${CONFIG_FILE}: ${warning}`);
        if (result.status === 'created') report('info', `Created ${CONFIG_FILE}.`);
        return result.values;
    } catch (error) {
        if (!(error instanceof ConfigSyntaxError)) throw error;
        report('error', `${CONFIG_FILE} is not valid TOML: ${error.message}. Using defaults until it is fixed.`);
        return defaultValues(configSchema);
    }
}

function configStore(files: DataFiles): ConfigStore {
    return {
        read: () => (files.stat(CONFIG_FILE) ? strFromU8(files.readFile(CONFIG_FILE)) : undefined),
        write: (text) => files.writeFile(CONFIG_FILE, strToU8(text))
    };
}
