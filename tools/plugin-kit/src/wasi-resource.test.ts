import { describe, expect, it, vi } from 'vitest';
import { disposeWasiResource } from './wasi-resource.ts';

describe('disposeWasiResource', () => {
    it('calls Symbol.dispose when the runtime provides it', () => {
        const dispose = vi.fn();

        disposeWasiResource({ [Symbol.dispose]: dispose });

        expect(dispose).toHaveBeenCalledOnce();
    });

    it('uses drop when Symbol.dispose is unavailable', () => {
        const drop = vi.fn();

        disposeWasiResource({ drop });

        expect(drop).toHaveBeenCalledOnce();
    });

    it('accepts absent optional resources from QuickJS and generated JS bindings', () => {
        expect(() => disposeWasiResource(null)).not.toThrow();
        expect(() => disposeWasiResource(undefined)).not.toThrow();
    });

    it('does nothing when the runtime exposes neither cleanup method', () => {
        expect(() => disposeWasiResource({})).not.toThrow();
    });
});
