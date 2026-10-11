import type { ConfigStore } from '@pumpkin-plugins/config';

/** A config-store write buffer that commits only after the caller validates the loaded config. */
export interface ConfigTransaction {
    readonly store: ConfigStore;
    commit(): void;
}

/** Defers loader normalization/default writes so semantic validation can leave invalid files intact. */
export function createConfigTransaction(
    read: () => string | undefined,
    write: (text: string) => void
): ConfigTransaction {
    let pending: string | undefined;
    let hasPending = false;
    return {
        store: {
            read,
            write: (text) => {
                pending = text;
                hasPending = true;
            }
        },
        commit: () => {
            if (!hasPending || pending === undefined) return;
            write(pending);
            pending = undefined;
            hasPending = false;
        }
    };
}
