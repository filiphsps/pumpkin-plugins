import { describe, expect, it } from 'vitest';
import { canonicalRegistryId } from './registry-id.ts';

describe(canonicalRegistryId.name, () => {
    it('adds the Minecraft namespace to a bare ID', () => {
        expect(canonicalRegistryId('torch')).toBe('minecraft:torch');
    });

    it('preserves an explicitly namespaced ID', () => {
        expect(canonicalRegistryId('example:torch')).toBe('example:torch');
    });
});
