import { table } from '@pumpkin-plugins/docs';
import type { RouterIdentity } from '@pumpkin-plugins/port-mapping';

/** One model of a router, as the blocklist knows it. */
export interface BlockedModel {
    /** Shown in the README. */
    name: string;
    /** Matched against the model, model number and name the router gives. */
    match: RegExp;
}

/** A make of router, or some of its models, that UPnPumpkin stays away from. */
export interface BlockedRouter {
    /** Shown in the README. */
    manufacturer: string;
    /** Matched against the manufacturer the router gives. A router that doesn't say who made it never matches. */
    match: RegExp;
    /** The models that are blocked. Leave it out to block the whole make. */
    models?: readonly BlockedModel[];
    /** Why, for the README and for the people running into it. A short phrase without a full stop. */
    reason: string;
}

/**
 * The routers UPnPumpkin does not touch: it is turned off when it finds one. Add a make when none
 * of its routers work, or single models when only they fail or misbehave. The README table is
 * generated from this list (`pnpm readme`).
 */
export const BLOCKED_ROUTERS: readonly BlockedRouter[] = [
    {
        manufacturer: 'Telekom',
        match: /telekom/i,
        reason: 'Telekom routers (Speedport) do not support UPnP or NAT-PMP'
    }
];

/** Where people can read which routers are blocked. */
export const BLOCKLIST_URL =
    'https://github.com/filiphsps/pumpkin-plugins/tree/master/packages/upnpumpkin#unsupported-routers';

/**
 * Looks a router up in the blocklist.
 * @param identity - What is known about the router.
 * @param rules - The blocklist.
 * @returns The rule that blocks it, or undefined. A rule for single models only blocks a router whose model is known.
 */
export function findBlocked(identity: RouterIdentity, rules: readonly BlockedRouter[] = BLOCKED_ROUTERS) {
    const { manufacturer, model, modelNumber, name } = identity;
    if (!manufacturer) return undefined;
    const names = [model, modelNumber, name].filter((text): text is string => Boolean(text));
    for (const rule of rules) {
        if (!rule.match.test(manufacturer)) continue;
        if (!rule.models) return rule;
        if (rule.models.some((m) => names.some((text) => m.match.test(text)))) return rule;
    }
    return undefined;
}

/**
 * Why a router is blocked, in the form the port mapper's `screen` takes.
 * @param identity - What is known about the router.
 * @returns The reason, or undefined when the router may be used.
 */
export function blockedReason(identity: RouterIdentity): string | undefined {
    return findBlocked(identity)?.reason;
}

/**
 * The README table of blocked routers.
 * @param rules - The blocklist.
 */
export function renderBlockedRouters(rules: readonly BlockedRouter[] = BLOCKED_ROUTERS): string {
    if (rules.length === 0) return 'No router is blocked.';
    return table(
        ['Make', 'Models', 'Why'],
        rules.map((rule) => [
            rule.manufacturer,
            rule.models ? rule.models.map((m) => m.name).join(', ') : 'All models',
            `${rule.reason}.`
        ])
    );
}
