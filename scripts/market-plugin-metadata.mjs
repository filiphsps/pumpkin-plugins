// Prints the Market description from a plugin's README and commands from its info module.
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
    translatedDescriptions: { 'en-US': marketDescription(pluginDir, info.description) },
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

function marketDescription(pluginDir, summary) {
    let readme;
    try {
        readme = fs.readFileSync(path.join(pluginDir, 'README.md'), 'utf8');
    } catch (error) {
        if (error?.code === 'ENOENT') return summary;
        throw error;
    }

    const details = describeReadme(readme);
    return details ? `${summary}\n\n${details}` : summary;
}

function describeReadme(readme) {
    const markdown = readme
        .replace(/<!--\s*docs:begin ([\w-]+)\s*-->[\s\S]*?<!--\s*docs:end \1\s*-->/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '');
    const sections = [];
    let section = { depth: 0, heading: undefined, lines: [] };
    let fence;

    for (const line of markdown.split(/\r?\n/)) {
        const fenceMarker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
        if (fence) {
            section.lines.push(line);
            if (fenceMarker?.[0] === fence.character && fenceMarker.length >= fence.length) fence = undefined;
            continue;
        }
        if (fenceMarker) {
            fence = { character: fenceMarker[0], length: fenceMarker.length };
            section.lines.push(line);
            continue;
        }

        const heading = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
        if (heading) {
            sections.push(section);
            const depth = heading[1].length;
            const title = heading[2].replace(/\s+#+\s*$/, '').trim();
            section = { depth, heading: depth === 1 ? undefined : title, lines: [] };
        } else {
            section.lines.push(line);
        }
    }
    sections.push(section);

    const content = [];
    let skippedDepth;
    for (const current of sections) {
        if (skippedDepth !== undefined) {
            if (current.depth > skippedDepth) continue;
            skippedDepth = undefined;
        }
        if (current.heading && isMarketExcludedSection(current.heading)) {
            skippedDepth = current.depth;
            continue;
        }

        const body = current.lines.join('\n').trim();
        if (!body) continue;
        content.push(current.heading ? `${'#'.repeat(current.depth)} ${current.heading}\n\n${body}` : body);
    }

    return content.join('\n\n');
}

function isMarketExcludedSection(heading) {
    const normalized = heading
        .replace(/^[^\p{L}\p{N}]+/u, '')
        .trim()
        .toLowerCase();
    return /^(?:install(?:ation)?|commands?)(?:\b|$)/.test(normalized);
}
