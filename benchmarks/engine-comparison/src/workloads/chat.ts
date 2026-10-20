import type { WorkloadScenario } from '../benchmark-workloads.ts';
import { PERMISSION_WORLDS } from './shared.ts';

const CHAT_MESSAGE_COUNT = 3_000;
const SCOREBOARD_PLAYER_COUNT = 3_000;
const SCOREBOARD_LINES = ['&6%player%', '&7World: &f%world%', '&7Balance: &a$%balance%', '&7Online: &f%online%'];

/** Chat template and scoreboard text rendering workloads. */
export const CHAT_WORKLOADS: readonly WorkloadScenario[] = [
    {
        name: 'chat-formatting',
        area: 'Chat template formatting and filtering',
        operationsPerSample: CHAT_MESSAGE_COUNT,
        run: runChatFormatting,
    },
    {
        name: 'scoreboard-rendering',
        area: 'Scoreboard text rendering',
        operationsPerSample: SCOREBOARD_PLAYER_COUNT * SCOREBOARD_LINES.length,
        run: runScoreboardRendering,
    },
];

const CHAT_TEMPLATES = [
    '&a%player%&7: Hello from %world%',
    '&b%player%&7 paid %balance% coins for a shop item',
    '&c%player%&7 shared a fake scamlink in %world%',
];
const CHAT_FILTERS = ['badword', 'scamlink', 'discord.gg/fake'];

function runChatFormatting(): number {
    let checksum = 0;
    for (let index = 0; index < CHAT_MESSAGE_COUNT; index++) {
        const player = `Player${index % 1_500}`;
        const world = PERMISSION_WORLDS[index % PERMISSION_WORLDS.length];
        const balance = (index * 83) % 100_000;
        const rawMessage = CHAT_TEMPLATES[index % CHAT_TEMPLATES.length]
            .replace(/%player%/g, player)
            .replace(/%world%/g, world)
            .replace(/%balance%/g, balance.toString());
        const normalizedMessage = rawMessage.toLowerCase();
        const blocked = CHAT_FILTERS.some((term) => normalizedMessage.includes(term));
        const formattedMessage = rawMessage.replace(/&([0-9a-fk-or])/gi, '§$1');
        checksum += formattedMessage.length + (blocked ? 1 : 0);
    }
    return checksum;
}

function runScoreboardRendering(): number {
    let checksum = 0;
    for (let playerId = 0; playerId < SCOREBOARD_PLAYER_COUNT; playerId++) {
        const playerName = `Player${playerId}`;
        const world = PERMISSION_WORLDS[playerId % PERMISSION_WORLDS.length];
        const balance = ((playerId * 97) % 100_000).toString();
        for (const line of SCOREBOARD_LINES) {
            const rendered = line
                .replace(/%player%/g, playerName)
                .replace(/%world%/g, world)
                .replace(/%balance%/g, balance)
                .replace(/%online%/g, '3000')
                .replace(/&([0-9a-fk-or])/gi, '§$1');
            checksum += rendered.length;
        }
    }
    return checksum;
}
