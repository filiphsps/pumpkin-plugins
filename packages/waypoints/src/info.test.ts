import { describe, expect, it } from 'vitest';
import { formatPlaceholderToken, info } from './info.ts';
import { waypointPlaceholderDefinitions } from './placeholders/definitions.ts';

describe('Waypoints plugin placeholder metadata', () => {
    it('formats each token with an example of its argument kind', () => {
        expect(formatPlaceholderToken({ name: 'count', description: '' })).toBe('%waypoints_count%');
        expect(formatPlaceholderToken({ name: 'nearest_id', argument: 'rank', description: '' })).toBe(
            '%waypoints_nearest_id:2%',
        );
        expect(formatPlaceholderToken({ name: 'nearby_count', argument: 'radius', description: '' })).toBe(
            '%waypoints_nearby_count:128%',
        );
        expect(formatPlaceholderToken({ name: 'waypoint_exists', argument: 'uuid', description: '' })).toBe(
            '%waypoints_waypoint_exists:11111111-1111-4111-8111-111111111111%',
        );
    });

    it('generates the advertised README table from the registered definition list', () => {
        const table = info.blocks?.placeholders ?? '';
        const actual = [...table.matchAll(/`(%waypoints_[a-z0-9_]+(?::[^%]+)?%)`/g)].map((match) => match[1]);

        expect(actual).toEqual(waypointPlaceholderDefinitions.map((definition) => formatPlaceholderToken(definition)));
    });
});
