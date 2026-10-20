import type { WorkloadScenario } from '../benchmark-workloads.ts';

const ECONOMY_TRANSACTION_COUNT = 12_000;
const INVENTORY_GRANT_COUNT = 2_500;
const COOLDOWN_ATTEMPT_COUNT = 20_000;
const SCHEDULED_TASK_COUNT = 6_000;

/** Economy, inventory, cooldown and scheduler workloads. */
export const GAMEPLAY_WORKLOADS: readonly WorkloadScenario[] = [
    {
        name: 'economy-transfers',
        area: 'Balance transfer processing',
        operationsPerSample: ECONOMY_TRANSACTION_COUNT,
        run: runEconomyTransfers,
    },
    {
        name: 'inventory-stacking',
        area: 'Inventory stack allocation',
        operationsPerSample: INVENTORY_GRANT_COUNT,
        run: runInventoryStacking,
    },
    {
        name: 'cooldown-rate-limit',
        area: 'Cooldown and rate-limit checks',
        operationsPerSample: COOLDOWN_ATTEMPT_COUNT,
        run: runCooldownRateLimit,
    },
    {
        name: 'tick-scheduler',
        area: 'Scheduled task processing',
        operationsPerSample: SCHEDULED_TASK_COUNT,
        run: runTickScheduler,
    },
];

function runEconomyTransfers(): number {
    const balances = new Map<number, number>();
    for (let playerId = 0; playerId < 4_000; playerId++) balances.set(playerId, 50_000 + playerId * 5);

    const transactions: [number, number, number][] = [];
    for (let transactionId = 0; transactionId < ECONOMY_TRANSACTION_COUNT; transactionId++) {
        const senderId = transactionId % 4_000;
        const recipientId = (transactionId * 17 + 29) % 4_000;
        const amount = ((transactionId * 97) % 350) + 1;
        const senderBalance = balances.get(senderId) ?? 0;
        if (senderBalance < amount || senderId === recipientId) continue;

        balances.set(senderId, senderBalance - amount);
        balances.set(recipientId, (balances.get(recipientId) ?? 0) + amount);
        transactions.push([senderId, recipientId, amount]);
    }

    let checksum = transactions.length;
    for (const [senderId, recipientId, amount] of transactions) {
        checksum += senderId + recipientId + amount;
    }
    for (const [playerId, balance] of balances) checksum += (playerId + 1) * balance;
    return checksum;
}

interface ItemStack {
    count: number;
    itemId: string;
}

function runInventoryStacking(): number {
    const inventory = new Array<ItemStack | undefined>(36).fill(undefined);
    for (let slot = 0; slot < 24; slot++)
        inventory[slot] = { itemId: `minecraft:item${slot % 48}`, count: 32 + (slot % 32) };

    let itemsAdded = 0;
    for (let grant = 0; grant < INVENTORY_GRANT_COUNT; grant++) {
        const itemId = `minecraft:item${grant % 48}`;
        const count = ((grant * 13) % 96) + 1;
        itemsAdded += addToInventory(inventory, itemId, count);
    }

    let checksum = itemsAdded;
    for (let slot = 0; slot < inventory.length; slot++) {
        const stack = inventory[slot];
        if (stack !== undefined) checksum += (slot + 1) * stack.count + stack.itemId.length;
    }
    return checksum;
}

function addToInventory(inventory: Array<ItemStack | undefined>, itemId: string, count: number): number {
    let remaining = count;
    for (const stack of inventory) {
        if (stack?.itemId !== itemId || stack.count === 64) continue;
        const moved = Math.min(64 - stack.count, remaining);
        stack.count += moved;
        remaining -= moved;
        if (remaining === 0) return count;
    }

    while (remaining > 0) {
        const emptySlot = inventory.indexOf(undefined);
        if (emptySlot === -1) break;
        const moved = Math.min(64, remaining);
        inventory[emptySlot] = { itemId, count: moved };
        remaining -= moved;
    }
    return count - remaining;
}

function runCooldownRateLimit(): number {
    const lastAllowedTick = new Map<string, number>();
    const commandNames = ['home', 'warp', 'message', 'pay'];
    let allowed = 0;
    let blocked = 0;

    for (let attempt = 0; attempt < COOLDOWN_ATTEMPT_COUNT; attempt++) {
        const playerId = attempt % 64;
        const command = commandNames[Math.floor(attempt / 64) % commandNames.length];
        const tick = Math.floor(attempt / 4);
        const key = `${playerId}:${command}`;
        const previousTick = lastAllowedTick.get(key);
        if (previousTick === undefined || tick - previousTick >= 100) {
            lastAllowedTick.set(key, tick);
            allowed++;
        } else {
            blocked++;
        }
    }
    return allowed * 31 + blocked;
}

interface ScheduledTask {
    id: number;
    repeatEveryTicks: number;
}

function runTickScheduler(): number {
    const tasksByTick: ScheduledTask[][] = Array.from({ length: 1_200 }, () => []);
    for (let taskId = 0; taskId < SCHEDULED_TASK_COUNT; taskId++) {
        const dueTick = (taskId * 37) % 600;
        tasksByTick[dueTick].push({ id: taskId, repeatEveryTicks: taskId % 4 === 0 ? 20 + (taskId % 60) : 0 });
    }

    let callbacks = 0;
    let checksum = 0;
    for (let tick = 0; tick < tasksByTick.length; tick++) {
        for (const task of tasksByTick[tick]) {
            callbacks++;
            checksum = (checksum + task.id * (tick + 1)) >>> 0;
            const nextTick = tick + task.repeatEveryTicks;
            if (task.repeatEveryTicks > 0 && nextTick < tasksByTick.length) tasksByTick[nextTick].push(task);
        }
    }
    return checksum + callbacks;
}
