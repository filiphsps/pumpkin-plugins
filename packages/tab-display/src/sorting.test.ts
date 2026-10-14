import { describe, expect, it } from 'vitest';
import { assignDenseOrders, type SortPlayer, type SortRule, sortPlayers } from './sorting.ts';

const players: readonly SortPlayer[] = [
    { uuid: 'b', name: 'Alex', ping: 40 },
    { uuid: 'c', name: 'Bea', ping: 10 },
    { uuid: 'a', name: 'Alex', ping: 40 },
];

describe('tab list sorting', () => {
    it('uses UUID as a deterministic final tie breaker', () => {
        expect(sortPlayers(players, [{ kind: 'name', direction: 'ascending' }]).map((player) => player.uuid)).toEqual([
            'a',
            'b',
            'c',
        ]);
    });

    it('puts missing and invalid ping values last in either direction', () => {
        const values: readonly SortPlayer[] = [
            { uuid: 'missing', name: 'A' },
            { uuid: 'valid', name: 'Z', ping: 20 },
            { uuid: 'invalid', name: 'B', ping: Number.NaN },
        ];
        for (const direction of ['ascending', 'descending'] as const) {
            expect(sortPlayers(values, [{ kind: 'ping', direction }]).map((player) => player.uuid)).toEqual([
                'valid',
                'invalid',
                'missing',
            ]);
        }
    });

    it('assigns dense signed-32-bit native ranks in sorted order', () => {
        const rules: readonly SortRule[] = [{ kind: 'name', direction: 'descending' }];
        expect(assignDenseOrders(players, rules)).toEqual([
            { uuid: 'c', order: 0 },
            { uuid: 'a', order: 1 },
            { uuid: 'b', order: 2 },
        ]);
    });

    it('does not use locale-sensitive ordering', () => {
        const values: readonly SortPlayer[] = [
            { uuid: '1', name: 'ä' },
            { uuid: '2', name: 'z' },
            { uuid: '3', name: 'A' },
        ];
        expect(sortPlayers(values, [{ kind: 'name', direction: 'ascending' }]).map((player) => player.name)).toEqual([
            'A',
            'z',
            'ä',
        ]);
    });
});
