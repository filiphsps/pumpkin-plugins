import type { WorkloadScenario } from '../benchmark-workloads.ts';
import { isRecord, PERMISSION_WORLDS } from './shared.ts';

const AUDIT_EVENT_COUNT = 12_000;
const AUDIT_QUERY_COUNT = 1_000;
const STORED_PLAYER_COUNT = 1_200;
const PAYLOAD_PACKET_COUNT = 256;
const PAYLOAD_FIELD_COUNT = 64;

/** Audit history, player-state JSON and binary payload workloads. */
export const STORAGE_WORKLOADS: readonly WorkloadScenario[] = [
    {
        name: 'audit-history',
        area: 'Audit history filtering',
        operationsPerSample: AUDIT_EVENT_COUNT + AUDIT_QUERY_COUNT,
        run: runAuditHistory,
    },
    {
        name: 'player-state-json',
        area: 'Player-state JSON round trip',
        operationsPerSample: STORED_PLAYER_COUNT,
        run: runPlayerStatePersistence,
    },
    {
        name: 'custom-payload',
        area: 'Custom payload encoding',
        operationsPerSample: PAYLOAD_PACKET_COUNT * PAYLOAD_FIELD_COUNT,
        run: runPacketEncoding,
    },
];

interface AuditRecord {
    action: string;
    tick: number;
    world: string;
    x: number;
    z: number;
}

function runAuditHistory(): number {
    const eventsByPlayer = new Map<number, AuditRecord[]>();
    for (let eventId = 0; eventId < AUDIT_EVENT_COUNT; eventId++) {
        const playerId = eventId % 2_048;
        const records = eventsByPlayer.get(playerId) ?? [];
        records.push({
            tick: eventId * 2,
            world: PERMISSION_WORLDS[eventId % PERMISSION_WORLDS.length],
            x: ((eventId * 31) % 2_000) - 1_000,
            z: ((eventId * 47) % 2_000) - 1_000,
            action: eventId % 2 === 0 ? 'block-break' : 'block-place',
        });
        eventsByPlayer.set(playerId, records);
    }

    let checksum = 0;
    for (let query = 0; query < AUDIT_QUERY_COUNT; query++) {
        const playerId = query % 2_048;
        const minimumTick = query * 8;
        const maximumTick = minimumTick + 4_000;
        const world = PERMISSION_WORLDS[query % PERMISSION_WORLDS.length];
        for (const event of eventsByPlayer.get(playerId) ?? []) {
            if (
                event.tick >= minimumTick &&
                event.tick <= maximumTick &&
                event.world === world &&
                Math.abs(event.x) < 800 &&
                Math.abs(event.z) < 800
            ) {
                checksum += event.tick + event.action.length + event.x + event.z;
            }
        }
    }
    return checksum;
}

interface StoredPlayerState {
    balanceCents: number;
    homes: { name: string; world: string; x: number; y: number; z: number }[];
    name: string;
    preferences: { chat: boolean; privateMessages: boolean; scoreboard: boolean };
    uuid: string;
}

function runPlayerStatePersistence(): number {
    const players: StoredPlayerState[] = [];
    for (let playerId = 0; playerId < STORED_PLAYER_COUNT; playerId++) {
        players.push({
            uuid: `player-${playerId.toString(16)}`,
            name: `Player${playerId}`,
            balanceCents: playerId * 193,
            homes: [
                {
                    name: 'home',
                    world: PERMISSION_WORLDS[playerId % PERMISSION_WORLDS.length],
                    x: playerId,
                    y: 64,
                    z: -playerId,
                },
                { name: 'farm', world: 'survival', x: playerId * 2, y: 70, z: playerId * 3 },
            ],
            preferences: {
                chat: playerId % 5 !== 0,
                privateMessages: playerId % 7 !== 0,
                scoreboard: playerId % 3 !== 0,
            },
        });
    }

    const serialized = JSON.stringify({ schemaVersion: 2, players });
    const restored: unknown = JSON.parse(serialized);
    if (!isRecord(restored) || restored.schemaVersion !== 2 || !Array.isArray(restored.players)) return -1;

    let checksum = serialized.length;
    for (const player of restored.players as StoredPlayerState[]) {
        checksum += player.balanceCents + player.homes.length + player.name.length;
    }
    return checksum;
}

function runPacketEncoding(): number {
    const payload = new Uint8Array(PAYLOAD_FIELD_COUNT * 4);
    const view = new DataView(payload.buffer);
    let checksum = 0;
    for (let packet = 0; packet < PAYLOAD_PACKET_COUNT; packet++) {
        for (let field = 0; field < PAYLOAD_FIELD_COUNT; field++) {
            view.setUint32(field * 4, (packet * 0x9e3779b1 + field) >>> 0, false);
        }
        for (let field = 0; field < PAYLOAD_FIELD_COUNT; field++)
            checksum = (checksum + view.getUint32(field * 4, false)) >>> 0;
    }
    return checksum;
}
