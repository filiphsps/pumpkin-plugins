export const resourceProxySource = /* JavaScript */ `
globalThis.__staticHermesWrapResource = (resource) => {
    let disposed = false;
    const isDisposed = () => disposed || resource.__isValid === false;
    return new Proxy(resource, {
        get(target, key) {
            if (key === "__staticHermesResource") return target;
            if (key === "__staticHermesDisposed") return isDisposed();
            if (key === "__isValid") return !isDisposed();
            if (key === Symbol.dispose) {
                const dispose = Reflect.get(target, key, target);
                const release = typeof dispose === "function" ? dispose : Reflect.get(target, "drop", target);
                return typeof release === "function" ? (...args) => {
                    if (isDisposed()) return;
                    disposed = true;
                    return Reflect.apply(release, target, args);
                } : undefined;
            }
            if (key === "drop") {
                const drop = Reflect.get(target, key, target);
                return typeof drop === "function" ? (...args) => {
                    if (isDisposed()) return;
                    disposed = true;
                    return Reflect.apply(drop, target, args);
                } : drop;
            }
            if (isDisposed()) throw new Error("Cannot use a disposed or transferred resource");
            const member = Reflect.get(target, key, target);
            return typeof member === "function" ? (...args) => Reflect.apply(member, target, args) : member;
        }
    });
};
`;
