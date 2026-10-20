import { ConfigSyntaxError } from '@pumpkin-plugins/config';
import { CommandFailed, type CommandHandlers } from '@pumpkin-plugins/docs';
import { CONFIG_FILE } from '../config/schema.ts';
import type { PortForwarder } from '../forwarder.ts';
import { refusalMessage } from '../refusal.ts';
import { reloadLines, statusLines } from './format.ts';
import type { commands } from './spec.ts';

/**
 * What each command does.
 * @param forwarder - What the commands report on and control.
 */
export function commandHandlers(forwarder: PortForwarder): CommandHandlers<typeof commands> {
    return {
        'upnp status': () => statusLines(forwarder.snapshot.info, forwarder.snapshot.mappings),
        'upnp reload': () => {
            try {
                forwarder.reload();
            } catch (err) {
                if (!(err instanceof ConfigSyntaxError)) throw err;
                throw new CommandFailed(
                    `${CONFIG_FILE} is not valid TOML (${err.message}). The current settings were kept; fix the file and run /upnp reload again.`,
                );
            }
            const { refusal } = forwarder;
            if (refusal) throw new CommandFailed(refusalMessage(refusal));
            return reloadLines(forwarder.snapshot.mappings.length);
        },
    };
}
