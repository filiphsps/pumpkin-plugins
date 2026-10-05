/** Explicitly releases a WASI resource when the host runtime exposes disposal. */
export function disposeWasiResource(resource: { [Symbol.dispose]?: () => void; drop?: () => void }): void {
    const dispose = resource[Symbol.dispose];
    if (typeof dispose === 'function') {
        dispose.call(resource);
        return;
    }
    const drop = resource.drop;
    if (typeof drop === 'function') drop.call(resource);
}
