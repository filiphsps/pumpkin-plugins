import { describe, expect, it } from 'vitest';
import { mergeJsonStringArray } from './jsonc.js';

describe('mergeJsonStringArray', () => {
    it('appends only missing values and leaves existing entries in place', () => {
        const source = `{
    "pumpkinPlugin": {
        "wasi": [
            "http",
            "http",
            "sockets"
        ]
    }
}`;

        const updated = mergeJsonStringArray(
            source,
            ['pumpkinPlugin', 'wasi'],
            ['filesystem', 'http', 'filesystem'],
            source,
        );

        expect(JSON.parse(updated).pumpkinPlugin.wasi).toEqual(['http', 'http', 'sockets', 'filesystem']);
        expect(updated).toContain('            "sockets",\n            "filesystem"\n');
    });
});
