import { describe, expect, it } from 'vitest';
import { taggedLogger } from './logger.ts';
import { MemoryLogger } from './testing/logger.ts';

describe(taggedLogger.name, () => {
    it('names the plugin at every level', () => {
        const lines = new MemoryLogger();
        const log = taggedLogger('Waypoints:', lines);

        log.debug('loaded 3 waypoints');
        log.info('PumpkinPIE provider is ready');
        log.warn('waypoint HUD tick failed');
        log.error('needs its data-folder permissions to run');

        expect(lines.lines).toEqual([
            'debug: Waypoints: loaded 3 waypoints',
            'info: Waypoints: PumpkinPIE provider is ready',
            'warn: Waypoints: waypoint HUD tick failed',
            'error: Waypoints: needs its data-folder permissions to run',
        ]);
    });
});
