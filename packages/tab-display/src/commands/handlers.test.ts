import { flattenCommands } from '@pumpkin-plugins/docs';
import { describe, expect, it, vi } from 'vitest';
import { commandHandlers } from './handlers.ts';
import { commands } from './spec.ts';

describe('TabDisplay commands', () => {
    it('declares operator-only nodes under the exact plugin prefix', () => {
        const flattened = flattenCommands(commands);
        expect(flattened.map(({ usage }) => usage)).toEqual([
            '/tabdisplay status',
            '/tabdisplay reload',
            '/tabdisplay inspect <player>',
        ]);
        expect(
            flattened.every(
                ({ permission, defaultPermission }) =>
                    permission.startsWith('TabDisplay:') && defaultPermission.tag === 'op',
            ),
        ).toBe(true);
        expect(flattened[2]?.arguments).toEqual([{ name: 'player', type: 'players' }]);
    });

    it('reports safe status and inspection context without resolved values', () => {
        const inspect = vi.fn(() => ({
            uuid: 'subject-uuid',
            name: 'Alex',
            edition: 'java',
            javaVersion: 'v-26-3',
            placeholderIds: ['player_name'],
        }));
        const handlers = commandHandlers({
            status: () => ({
                enabled: true,
                provider: 'ready',
                players: 1,
                javaPlayers: 1,
                bedrockPlayers: 0,
                javaVersions: ['v-26-3'],
                pendingJobs: 0,
                unresolved: ['rank'],
                bedrock: { kind: 'unsupported', reason: 'native roster unchanged' },
            }),
            reload: () => ({ kind: 'applied' }),
            inspect,
        });

        const status = handlers['tabdisplay status']({} as never).join('\n');
        const details = handlers['tabdisplay inspect <player>']({} as never, {
            player: [{ id: 'subject-uuid', name: 'Alex' }],
        }).join('\n');

        expect(status).toContain('Java versions: v-26-3');
        expect(status).toContain('Unresolved placeholder IDs: rank');
        expect(status).not.toContain('resolved value');
        expect(details).toContain('UUID: subject-uuid');
        expect(details).toContain('Placeholder IDs: player_name');
        expect(details).toContain('Resolved placeholder values are not shown.');
        expect(inspect).toHaveBeenCalledWith('subject-uuid');
    });

    it('rejects broad inspection selectors and reports reload validation errors', () => {
        const handlers = commandHandlers({
            status: () => ({
                enabled: true,
                provider: 'unavailable',
                players: 0,
                javaPlayers: 0,
                bedrockPlayers: 0,
                javaVersions: [],
                pendingJobs: 0,
                unresolved: [],
                bedrock: { kind: 'unsupported', reason: 'native roster unchanged' },
            }),
            reload: () => ({ kind: 'failed', reason: 'header.lines: invalid value' }),
            inspect: vi.fn(),
        });

        expect(
            handlers['tabdisplay inspect <player>']({} as never, {
                player: [
                    { id: 'one', name: 'One' },
                    { id: 'two', name: 'Two' },
                ],
            })[0],
        ).toMatchObject({ tone: 'error', text: expect.stringContaining('exactly one') });
        expect(handlers['tabdisplay reload']({} as never)[0]).toMatchObject({
            tone: 'error',
            text: expect.stringContaining('header.lines'),
        });
    });
});
