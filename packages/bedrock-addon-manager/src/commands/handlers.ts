import type { CommandHandlers } from '@pumpkin-plugins/docs';
import type { PackManager } from '../manager.ts';
import { listLines, reloadLines } from './format.ts';
import type { commands } from './spec.ts';

/**
 * What each command does.
 * @param manager - The manager the commands report on and control.
 */
export function commandHandlers(manager: PackManager): CommandHandlers<typeof commands> {
    return {
        'baddon list': () => listLines(manager.entries),
        'baddon reload': () => {
            manager.reload();
            return reloadLines(manager.entries.length);
        }
    };
}
