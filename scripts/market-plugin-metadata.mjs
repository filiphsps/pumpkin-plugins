// Prints the Market description from a plugin's README and commands from its info module. README
// paths become GitHub links at the plugin's release tag, since the Market can't resolve them.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { stripGeneratedBlocks } from '@pumpkin-plugins/docs/markdown';
import { Command } from 'commander';
import { loadPluginInfo } from './utils/plugin-info.mjs';

// Inline link and image targets, read the same way as in check-docs.mjs.
const LINK_TARGET = /(\]\(\s*<?)([^)\s>]+)/g;
const IMAGE_FILE = /\.(?:avif|gif|jpe?g|png|svg|webp)$/i;

const program = new Command()
    .name('market-plugin-metadata')
    .description("Print a plugin's Market metadata as JSON.")
    .argument('<plugin-dir>', 'Plugin package directory')
    .parse(process.argv);
const [pluginDir] = program.args;

const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'));
const { file: infoFile, info } = await loadPluginInfo(pluginDir, pkg);
if (typeof info.description !== 'string' || !info.description.trim()) {
    throw new Error(`${infoFile} must export plugin info with a description`);
}

const commands = info.commands ?? [];
if (!Array.isArray(commands)) throw new Error(`${infoFile} info.commands must be an array`);

const metadata = {
    translatedDescriptions: { 'en-US': marketDescription(pluginDir, pkg, info.description) },
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
            display_order: index,
        };
    }),
};

console.log(JSON.stringify(metadata, null, 2));

function marketDescription(pluginDir, pkg, summary) {
    let readme;
    try {
        readme = fs.readFileSync(path.join(pluginDir, 'README.md'), 'utf8');
    } catch (error) {
        if (error?.code === 'ENOENT') return summary;
        throw error;
    }

    const details = describeReadme(readme, (kind) => releaseReadmeUrl(pluginDir, pkg, kind));
    return details ? `${summary}\n\n${details}` : summary;
}

function describeReadme(readme, readmeUrl) {
    let markdown = stripGeneratedBlocks(readme);
    let previous;
    do {
        previous = markdown;
        markdown = markdown.replace(/<!--[\s\S]*?-->/g, '');
    } while (markdown !== previous);
    const sections = [];
    let section = { depth: 0, heading: undefined, lines: [] };
    let fence;

    for (const rawLine of markdown.split(/\r?\n/)) {
        const fenceMarker = /^ {0,3}(`{3,}|~{3,})/.exec(rawLine)?.[1];
        if (fence) {
            section.lines.push(rawLine);
            if (fenceMarker?.[0] === fence.character && fenceMarker.length >= fence.length) fence = undefined;
            continue;
        }
        if (fenceMarker) {
            fence = { character: fenceMarker[0], length: fenceMarker.length };
            section.lines.push(rawLine);
            continue;
        }

        const line = absoluteLinks(rawLine, readmeUrl);

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

function absoluteLinks(line, readmeUrl) {
    return line.replace(LINK_TARGET, (match, prefix, target) => {
        // Root-relative targets ("/docs/...") would resolve against github.com; plugin READMEs do not use them.
        if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) return match;
        const link = new URL(target, readmeUrl('blob'));
        return `${prefix}${IMAGE_FILE.test(link.pathname) ? new URL(target, readmeUrl('raw')).href : link.href}`;
    });
}

/** The plugin README's GitHub URL at its Release Please tag, as a `blob` page or a `raw` file. */
function releaseReadmeUrl(pluginDir, pkg, kind) {
    const { url, directory } = pkg.repository ?? {};
    if (typeof url !== 'string' || typeof directory !== 'string') {
        throw new Error(`${pluginDir}/package.json needs repository.url and repository.directory to link README paths`);
    }
    const root = path.resolve(pluginDir, path.relative(directory, '.'));
    const config = JSON.parse(fs.readFileSync(path.join(root, 'release-please-config.json'), 'utf8'));
    const component = config.packages?.[directory]?.component;
    if (typeof component !== 'string') throw new Error(`release-please-config.json has no component for ${directory}`);
    const repository = url.replace(/^git\+/, '').replace(/\.git$/, '');
    return `${repository}/${kind}/${component}-v${pkg.version}/${directory}/README.md`;
}
