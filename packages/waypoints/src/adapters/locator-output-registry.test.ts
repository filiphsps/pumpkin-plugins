import type { Uuid } from 'pumpkin:plugin/player@0.1.0';
import { MemoryFiles, MemoryLogger } from '@pumpkin-plugins/plugin-kit/testing';
import { describe, expect, it } from 'vitest';
import { WaypointService } from '../waypoints/service.ts';
import { WaypointStore } from '../waypoints/store.ts';
import { createLocatorOutputRegistry } from './locator-output-registry.ts';

describe('locator output registry', () => {
    it('registers Java Locator Bar as an edition and capability key, separate from map imports', () => {
        const service = new WaypointService(new WaypointStore(new MemoryFiles(), new MemoryLogger()));
        const registry = createLocatorOutputRegistry(service, (_id): Uuid | undefined => ({ high: 0, low: 0 }));

        expect(Object.keys(registry)).toEqual(['java:locator-bar']);
        expect(registry['java:locator-bar']?.key).toBe('java:locator-bar');
    });
});
