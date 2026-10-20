import { describe, expect, it } from 'vitest';
import { waypointPlaceholderDefinitions } from './definitions.ts';
import { parsePlaceholder } from './resolver.ts';

const sampleArguments = {
    radius: '10',
    rank: '1',
    uuid: '11111111-1111-4111-8111-111111111111',
    world: 'overworld',
};

describe('waypoint placeholder definitions', () => {
    it('advertises each identifier once', () => {
        const names = waypointPlaceholderDefinitions.map(({ name }) => name);
        expect(new Set(names).size).toBe(names.length);
    });

    it('advertises only identifiers the resolver can parse with their declared argument', () => {
        const unparsed = waypointPlaceholderDefinitions.filter(
            ({ name, argument }) =>
                parsePlaceholder(name, argument === undefined ? undefined : sampleArguments[argument]) === undefined,
        );
        expect(unparsed).toEqual([]);
    });
});
