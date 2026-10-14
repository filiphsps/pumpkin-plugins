import { TomlDate } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { field } from './fields.ts';
import { defaultValues, defineConfig, section } from './schema.ts';

describe(defaultValues.name, () => {
    it('preserves local-date and offset datetime metadata in defaults', () => {
        const localDate = new TomlDate('1979-05-27');
        const offsetDateTime = new TomlDate('1979-05-27T07:32:00.000-08:00');
        const schema = defineConfig('Demo', {
            calendar: section({
                description: 'Calendar settings.',
                fields: {
                    date: tomlDateField(localDate),
                    meeting: tomlDateField(offsetDateTime),
                },
            }),
        });

        const values = defaultValues(schema).calendar;

        expect(values.date).not.toBe(localDate);
        expect(values.date).toBeInstanceOf(TomlDate);
        expect(values.date?.isDate()).toBe(true);
        expect(values.date?.toISOString()).toBe('1979-05-27');
        expect(values.meeting).not.toBe(offsetDateTime);
        expect(values.meeting).toBeInstanceOf(TomlDate);
        expect(values.meeting?.toISOString()).toBe('1979-05-27T07:32:00.000-08:00');
    });
});

function tomlDateField(value: TomlDate) {
    return field<TomlDate>({
        type: 'table',
        description: 'A TOML date.',
        default: value,
        expected: 'a TOML date',
        example: value,
        parse: (raw) => (raw instanceof TomlDate ? { ok: true, value: raw } : { ok: false }),
        format: (date) => date.toISOString(),
    });
}
