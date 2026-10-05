import { describe, expect, it } from 'vitest';
import { compareVersions } from './updates.ts';

describe('compareVersions', () => {
    const ordered = [
        '1.0.0-alpha',
        '1.0.0-alpha.1',
        '1.0.0-alpha.beta',
        '1.0.0-beta',
        '1.0.0-beta.2',
        '1.0.0-beta.11',
        '1.0.0-rc.1',
        '1.0.0',
        '1.0.1',
        '1.1.0',
        '2.0.0'
    ];
    it.each(ordered.slice(1).map((version, index) => [ordered[index], version]))(
        'orders %s before %s',
        (current, latest) => {
            expect(compareVersions(current, latest)).toBe(-1);
            expect(compareVersions(latest, current)).toBe(1);
        }
    );

    it('ignores build metadata and accepts a leading v', () => {
        expect(compareVersions('v1.2.3+build.01', '1.2.3+other')).toBe(0);
    });

    it.each(['9007199254740992.0.0', '1.0.0-9007199254740992'])('preserves integer precision in %s', (version) => {
        expect(compareVersions(version, version.replace('992', '993'))).toBe(-1);
    });

    it.each(['1.0', '01.0.0', '1.0.0-01', '1.0.0-alpha..1', '1.0.0-.', '1.0.0+build..1', '1.0.0+', '1.0.0\n'])(
        'rejects invalid version %j',
        (version) => {
            expect(() => compareVersions(version, '1.0.0')).toThrow('Invalid semantic version');
            expect(() => compareVersions('1.0.0', version)).toThrow('Invalid semantic version');
        }
    );
});
