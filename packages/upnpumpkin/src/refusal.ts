import { describeIdentity, type RouterIdentity } from '@pumpkin-plugins/port-mapping';
import { BLOCKLIST_URL } from './blocklist.ts';

/** A router that UPnPumpkin turned down, and why. */
export interface Refusal {
    identity: RouterIdentity;
    reason: string;
}

/**
 * What to tell the person running the server when the router is blocked: the same words in the
 * log, in `/upnp reload` and in `/upnp status`.
 */
export function refusalMessage({ identity, reason }: Refusal): string {
    return `UPnPumpkin is disabled: ${describeIdentity(identity)} is a router it does not work with (${reason}). Forward the ports in the router's settings instead. Blocked routers are listed at ${BLOCKLIST_URL}`;
}
