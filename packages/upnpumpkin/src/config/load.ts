import { type ConfigStore, ConfigSyntaxError, defaultValues, loadConfig } from '@pumpkin-plugins/config';
import type { DataFiles } from '@pumpkin-plugins/plugin-kit/files';
import { colorLogValue, type Logger } from '@pumpkin-plugins/plugin-kit/logger';
import { strFromU8, strToU8 } from 'fflate';
import { CONFIG_FILE, CONFIG_RENDER_OPTIONS, type Config, configSchema } from './schema.ts';

function configStore(files: DataFiles): ConfigStore {
    return {
        read: () => (files.stat(CONFIG_FILE) ? strFromU8(files.readFile(CONFIG_FILE)) : undefined),
        write: (text) => files.writeFile(CONFIG_FILE, strToU8(text))
    };
}

/**
 * Loads the plugin's config, creating or upgrading the file as needed, and reports what happened.
 * A file that can't be read is never overwritten: the defaults are used until it is fixed.
 * @returns The settings to run with.
 */
export function loadPluginConfig(files: DataFiles, log: Logger): Config {
    try {
        const result = loadConfig(configSchema, configStore(files), CONFIG_RENDER_OPTIONS);
        for (const warning of result.warnings) log.warn(`${colorLogValue(CONFIG_FILE, 'cyan')}: ${warning}`);

        if (result.status === 'created')
            log.info(`Created ${colorLogValue(CONFIG_FILE, 'cyan')} with the default settings.`);
        else if (result.status === 'kept') {
            log.warn(
                `${colorLogValue(CONFIG_FILE, 'cyan')} has invalid values, so it was left as it is. Fix them and run /upnp reload.`
            );
        } else if (result.status === 'updated') {
            const changes = [
                result.added.length > 0 &&
                    `added ${result.added.map((key) => colorLogValue(key, 'yellow')).join(', ')}`,
                result.removed.length > 0 &&
                    `removed ${result.removed.map((key) => colorLogValue(key, 'yellow')).join(', ')}`
            ].filter(Boolean);
            log.info(
                `Updated ${colorLogValue(CONFIG_FILE, 'cyan')}${changes.length > 0 ? `: ${changes.join('; ')}` : ' to the current format'}.`
            );
        }
        return result.values;
    } catch (err) {
        if (!(err instanceof ConfigSyntaxError)) throw err;
        log.error(
            `${colorLogValue(CONFIG_FILE, 'cyan')} is not valid TOML (${err.message}). Using the default settings until it is fixed; the file was not changed.`
        );
        return defaultValues(configSchema);
    }
}
