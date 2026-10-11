/** A copied player snapshot used for deterministic tab ordering. */
export interface SortPlayer {
    readonly uuid: string;
    readonly name: string;
    readonly ping?: number;
}

/** A native sort key and its direction. */
export interface SortRule {
    readonly kind: 'name' | 'ping';
    readonly direction: 'ascending' | 'descending';
}

/** One dense ordering value to apply through Pumpkin's native player API. */
export interface DenseOrder {
    readonly uuid: string;
    readonly order: number;
}

/** Sorts by configured keys, then by UUID without locale-sensitive comparison. */
export function sortPlayers<T extends SortPlayer>(players: readonly T[], rules: readonly SortRule[]): T[] {
    return [...players].sort((left, right) => {
        for (const rule of rules) {
            const compared = compareRule(left, right, rule);
            if (compared !== 0) return compared;
        }
        return compareText(left.uuid, right.uuid);
    });
}

/** Assigns bounded, gapless ranks in the order the native API consumes. */
export function assignDenseOrders(players: readonly SortPlayer[], rules: readonly SortRule[]): DenseOrder[] {
    if (players.length > 2_147_483_648) throw new RangeError('Player count exceeds signed-32-bit tab order capacity');
    return sortPlayers(players, rules).map(({ uuid }, order) => ({ uuid, order }));
}

function compareRule(left: SortPlayer, right: SortPlayer, rule: SortRule): number {
    if (rule.kind === 'name') {
        const compared = compareText(left.name, right.name);
        return rule.direction === 'ascending' ? compared : -compared;
    }

    const leftPing = validPing(left.ping);
    const rightPing = validPing(right.ping);
    if (leftPing === undefined || rightPing === undefined) {
        if (leftPing === rightPing) return 0;
        return leftPing === undefined ? 1 : -1;
    }
    const compared = leftPing < rightPing ? -1 : leftPing > rightPing ? 1 : 0;
    return rule.direction === 'ascending' ? compared : -compared;
}

function validPing(value: number | undefined): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
