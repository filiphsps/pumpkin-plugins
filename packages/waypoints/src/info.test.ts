import { describe, expect, it } from 'vitest';
import { info } from './info.ts';
import { waypointPlaceholderDefinitions } from './placeholders/definitions.ts';

const argumentExamples = {
    rank: '2',
    radius: '128',
    uuid: '11111111-1111-4111-8111-111111111111',
    world: 'world',
} as const;

describe('Waypoints plugin placeholder metadata', () => {
    it('generates the advertised README table from the registered definition list', () => {
        const table = info.blocks?.placeholders ?? '';
        const actual = [...table.matchAll(/`(%waypoints_[a-z0-9_]+(?::[^%]+)?%)`/g)].map((match) => match[1]);
        const expected = waypointPlaceholderDefinitions.map(({ name, argument }) => {
            const example = argument === undefined ? '' : `:${argumentExamples[argument]}`;
            return `%waypoints_${name}${example}%`;
        });

        expect(actual).toEqual(expected);
    });
});
