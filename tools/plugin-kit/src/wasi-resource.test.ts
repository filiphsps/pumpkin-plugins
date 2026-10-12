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

    it('prefers the repeatable host drop method when both are available', () => {
        const drop = vi.fn();
        const dispose = vi.fn();

        disposeWasiResource({ drop, [Symbol.dispose]: dispose });

        expect(drop).toHaveBeenCalledOnce();
        expect(dispose).not.toHaveBeenCalled();
    });

    it('accepts absent optional resources from QuickJS and generated JS bindings', () => {
        expect(() => disposeWasiResource(null)).not.toThrow();
        expect(() => disposeWasiResource(undefined)).not.toThrow();
    });

    it('does nothing when the runtime exposes neither cleanup method', () => {
        expect(() => disposeWasiResource({})).not.toThrow();
    });

    it('does not dispose a resource after ownership has been transferred', () => {
        const drop = vi.fn();
        const dispose = vi.fn();

        disposeWasiResource({ __isValid: false, drop, [Symbol.dispose]: dispose });

        expect(drop).not.toHaveBeenCalled();
        expect(dispose).not.toHaveBeenCalled();
    });

    it('detects transferred resources behind a Static Hermes facade', () => {
        const dispose = vi.fn();

        disposeWasiResource({ __staticHermesResource: { __isValid: false }, [Symbol.dispose]: dispose });

        expect(dispose).not.toHaveBeenCalled();
    });
});
