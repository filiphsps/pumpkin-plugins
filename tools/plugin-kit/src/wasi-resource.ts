interface WasiResourceLike {
    readonly __isValid?: boolean;
    readonly __staticHermesDisposed?: boolean;
    readonly __staticHermesResource?: { readonly __isValid?: boolean };
    drop?: () => void;
    [Symbol.dispose]?: () => void;
}

/** Explicitly releases a WASI resource still owned by this plugin. */
export function disposeWasiResource(resource: WasiResourceLike | null | undefined): void {
    if (resource == null) return;
    if (
        resource.__isValid === false ||
        resource.__staticHermesDisposed === true ||
        resource.__staticHermesResource?.__isValid === false
    )
        return;
    const drop = resource.drop;
    if (typeof drop === 'function') {
        drop.call(resource);
        return;
    }
    const dispose = resource[Symbol.dispose];
    if (typeof dispose === 'function') {
        dispose.call(resource);
    }
}
