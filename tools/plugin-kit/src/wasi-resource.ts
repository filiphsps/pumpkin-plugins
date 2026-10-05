/** Explicitly releases a WASI resource when the host runtime exposes disposal. */
export function disposeWasiResource(
    resource: { [Symbol.dispose]?: () => void; drop?: () => void } | null | undefined
): void {
    if (resource == null) return;
    const dispose = resource[Symbol.dispose];
    if (typeof dispose === 'function') {
        dispose.call(resource);
        return;
    }
    const drop = resource.drop;
    if (typeof drop === 'function') drop.call(resource);
}
