import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { wrapBundleForDiagnostics } from './bundle-diagnostics.ts';

describe('wrapBundleForDiagnostics', () => {
    it('installs the resource proxy before evaluating plugin code', () => {
        const source = wrapBundleForDiagnostics('globalThis.pluginStarted = true;');

        expect(source.indexOf('__staticHermesWrapResource')).toBeGreaterThanOrEqual(0);
        expect(source.indexOf('__staticHermesWrapResource')).toBeLessThan(
            source.indexOf('globalThis.pluginStarted = true;'),
        );
    });

    it('records the thrown error and rethrows the same error during module initialization', () => {
        const failure = new TypeError('init failed');
        const expectedStack = failure.stack;
        const context = { failure };
        let thrown;

        try {
            runInNewContext(wrapBundleForDiagnostics('throw failure;'), context);
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBe(failure);
        expect(context.__pumpkinPluginInitError).toBe(expectedStack);
    });

    it('records a readable message when initialization throws a non-error value', () => {
        const context = { failure: 'initialization failed' };
        let thrown;

        try {
            runInNewContext(wrapBundleForDiagnostics('throw failure;'), context);
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBe('initialization failed');
        expect(context.__pumpkinPluginInitError).toBe('initialization failed');
    });

    it('rejects a saved resource method after the resource is dropped', () => {
        const context = { calls: [] };
        let thrown;

        try {
            runInNewContext(
                wrapBundleForDiagnostics(`
                    const resource = __staticHermesWrapResource({
                        read() { calls.push('read'); },
                        drop() { calls.push('drop'); }
                    });
                    const read = resource.read;
                    resource.drop();
                    read();
                `),
                context,
            );
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toMatchObject({ message: 'Cannot use a disposed or transferred resource' });
        expect(context.calls).toEqual(['drop']);
    });
});
