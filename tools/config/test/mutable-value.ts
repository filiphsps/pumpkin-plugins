import { field, type Parsed } from '../src/fields.ts';

export interface MutableValue {
    nested: {
        levels: number[];
        timestamp: Date;
    };
}

export function createMutableValue(): MutableValue {
    return { nested: { levels: [1, 2], timestamp: new Date('2025-01-02T03:04:05.000Z') } };
}

export function mutableValueField(options: { default?: MutableValue; migrateFrom?: readonly string[] } = {}) {
    const defaultValue = options.default ?? createMutableValue();

    return field<MutableValue>({
        type: 'table',
        description: 'Nested value.',
        default: defaultValue,
        expected: 'a nested value',
        example: defaultValue,
        migrateFrom: options.migrateFrom,
        parse: parseMutableValue,
        format: (value) =>
            `{ nested = { levels = [${value.nested.levels.join(', ')}], timestamp = ${value.nested.timestamp.toISOString()} } }`,
    });
}

function parseMutableValue(raw: unknown): Parsed<MutableValue> {
    if (!isRecord(raw) || !isRecord(raw.nested)) return { ok: false };

    const { levels, timestamp } = raw.nested;
    if (!Array.isArray(levels) || !levels.every((level) => typeof level === 'number')) return { ok: false };
    if (!(timestamp instanceof Date)) return { ok: false };

    return { ok: true, value: raw as unknown as MutableValue };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}
