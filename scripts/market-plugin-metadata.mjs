// Prints the Market description and commands derived from a plugin's info module.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const [pluginDir] = process.argv.slice(2);
if (!pluginDir) {
    console.error('usage: node scripts/market-plugin-metadata.mjs <plugin-dir>');
    process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'));
const infoFile = path.resolve(pluginDir, pkg.pumpkinPlugin?.info ?? 'src/info.ts');
const mod = await import(pathToFileURL(infoFile).href);
const info = mod.info ?? mod.default;
if (!info || typeof info.description !== 'string' || !info.description.trim()) {
    throw new Error(`${infoFile} must export plugin info with a description`);
}

const commands = info.commands ?? [];
if (!Array.isArray(commands)) throw new Error(`${infoFile} info.commands must be an array`);

const metadata = {
    translatedDescriptions: { 'en-US': info.description },
    commands: commands.map((command, index) => {
        if (!command || typeof command.usage !== 'string' || typeof command.description !== 'string') {
            throw new Error(`${infoFile} info.commands[${index}] must have usage and description strings`);
        }
        const name = command.usage.replace(/^\/+/, '').trim();
        if (!name) throw new Error(`${infoFile} info.commands[${index}] has an empty usage`);
        return {
            name,
            ...(typeof command.permission === 'string' ? { permission: command.permission } : {}),
            description: { 'en-US': command.description },
            display_order: index
        };
    })
};

console.log(JSON.stringify(metadata, null, 2));
