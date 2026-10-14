import { TomlDate } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { cloneConfigValue } from './clone.ts';

describe(cloneConfigValue.name, () => {
    it('keeps undefined as the optional-default sentinel', () => {
        expect(cloneConfigValue(undefined)).toBeUndefined();
    });

    it.each([
        ['null', null],
        ['functions', () => 1],
        ['symbols', Symbol('unsupported')],
    ])('rejects %s values', (_kind, value) => {
        expect(() => cloneConfigValue(value)).toThrow(TypeError);
    });

    it('rejects undefined in a table value', () => {
        expect(() => cloneConfigValue({ setting: undefined })).toThrow(TypeError);
    });

    it('rejects undefined in an array value', () => {
        expect(() => cloneConfigValue([undefined])).toThrow(TypeError);
    });

    it('rejects symbol-keyed table data instead of dropping it', () => {
        const key = Symbol('setting');

        expect(() => cloneConfigValue({ [key]: true })).toThrow(TypeError);
    });

    it('preserves supported TOML scalar and date values', () => {
        const date = new Date('2024-01-02T03:04:05.000Z');
        const tomlDate = new TomlDate('1979-05-27T07:32:00.000-08:00');
        const values = { bigint: 42n, boolean: true, date, integer: 7, string: 'ready', tomlDate };

        const copy = cloneConfigValue(values);

        expect(copy).toEqual(values);
        expect(copy.date).not.toBe(date);
        expect(copy.tomlDate).not.toBe(tomlDate);
        expect(copy.tomlDate.toISOString()).toBe('1979-05-27T07:32:00.000-08:00');
    });

    it.each([
        ['native Date', new Date(Number.NaN)],
        ['TomlDate', new TomlDate('not-a-date')],
    ])('rejects invalid %s values', (_kind, value) => {
        expect(() => cloneConfigValue(value)).toThrow(TypeError);
    });

    it('rejects Date subclasses instead of discarding their behavior', () => {
        class ExtendedDate extends Date {
            format(): string {
                return 'custom';
            }
        }

        expect(() => cloneConfigValue(new ExtendedDate('2024-01-02T03:04:05.000Z'))).toThrow(TypeError);
    });

    it('rejects TomlDate subclasses instead of discarding their behavior', () => {
        class ExtendedTomlDate extends TomlDate {
            format(): string {
                return 'custom';
            }
        }

        expect(() => cloneConfigValue(new ExtendedTomlDate('1979-05-27T07:32:00.000-08:00'))).toThrow(TypeError);
    });

    it('rejects native Date own properties instead of discarding them', () => {
        const date = new Date('2024-01-02T03:04:05.000Z') as Date & { label?: string };
        date.label = 'release';

        expect(() => cloneConfigValue(date)).toThrow(TypeError);
    });

    it('rejects TomlDate own properties instead of discarding them', () => {
        const date = new TomlDate('1979-05-27T07:32:00.000-08:00') as TomlDate & { label?: string };
        date.label = 'local time';

        expect(() => cloneConfigValue(date)).toThrow(TypeError);
    });

    it('rejects array subclasses', () => {
        class ExtendedArray extends Array<number> {}

        expect(() => cloneConfigValue(new ExtendedArray(1, 2))).toThrow(TypeError);
    });

    it('rejects sparse arrays', () => {
        expect(() => cloneConfigValue(new Array<number>(1))).toThrow(TypeError);
    });

    it('rejects accessor indices without invoking their getters', () => {
        const values = [1, 2];
        let getterCalls = 0;
        Object.defineProperty(values, '0', {
            configurable: true,
            enumerable: true,
            get: () => {
                getterCalls++;
                return 1;
            },
        });

        expect(() => cloneConfigValue(values)).toThrow(TypeError);
        expect(getterCalls).toBe(0);
    });

    it('rejects non-enumerable array indices', () => {
        const values = [1, 2];
        Object.defineProperty(values, '0', { enumerable: false });

        expect(() => cloneConfigValue(values)).toThrow(TypeError);
    });

    it('rejects arrays with extra own properties without calling their map method', () => {
        const values = [1, 2] as number[] & { label?: string };
        values.label = 'levels';
        Object.defineProperty(values, 'map', {
            value: () => {
                throw new Error('overridden map was called');
            },
        });

        expect(() => cloneConfigValue(values)).toThrow(TypeError);
    });
});
