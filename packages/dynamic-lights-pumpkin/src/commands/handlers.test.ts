import type { CommandSender } from 'pumpkin:plugin/command@0.1.0';
import { describe, expect, it } from 'vitest';
import { commandHandlers } from './handlers.ts';

describe(commandHandlers.name, () => {
    it('toggles the player who ran the command', () => {
        const toggled: string[] = [];
        const handlers = commandHandlers({
            togglePlayerLights: (player) => {
                toggled.push(player.getName());
                return false;
            },
        });

        expect(handlers.dynamiclights(playerSender('Alex'))).toEqual(['Dynamic lights disabled.']);
        expect(toggled).toEqual(['Alex']);
    });
});

function playerSender(name: string): CommandSender {
    return { asPlayer: () => ({ getName: () => name }) } as CommandSender;
}
