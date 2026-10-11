import { describe, expect, it, vi } from 'vitest';
import { loadTabDisplayConfig } from './config.ts';
import { createConfigTransaction } from './config-store.ts';

describe('configuration write transaction', () => {
    it('keeps generated defaults pending until validated and committed', () => {
        const write = vi.fn();
        const transaction = createConfigTransaction(() => undefined, write);

        const loaded = loadTabDisplayConfig(transaction.store);
        expect(write).not.toHaveBeenCalled();
        expect(loaded.config.general.version).toBe(1);

        transaction.commit();
        expect(write).toHaveBeenCalledOnce();
        expect(write.mock.calls[0]?.[0]).toContain('[general]');
        transaction.commit();
        expect(write).toHaveBeenCalledOnce();
    });

    it('does not persist an invalid configuration normalized by the schema reader', () => {
        const original = '[sorting]\nrules = [{ kind = "name", direction = "ascending" }]\n';
        let contents: string | undefined = original;
        const write = vi.fn((text: string) => {
            contents = text;
        });
        const transaction = createConfigTransaction(() => contents, write);

        expect(() => loadTabDisplayConfig(transaction.store)).toThrow(/sorting\.rules/);
        expect(write).not.toHaveBeenCalled();
        expect(contents).toBe(original);
    });
});
