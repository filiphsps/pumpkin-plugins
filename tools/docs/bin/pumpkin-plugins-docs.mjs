#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    generateActionReadmes,
    generateActionVersions,
    generateDocuments,
    generatePluginReadme,
    generateRootReadme
} from '../src/node.ts';

const args = process.argv.slice(2);
const check = args.includes('--check');
const positional = args.filter((arg) => arg !== '--check');
const command = positional[0] ?? 'plugin';
const cwd = process.cwd();

try {
    if (
        args.some((arg) => arg.startsWith('--') && arg !== '--check') ||
        !['plugin', 'root', 'generate', 'actions', 'action-versions'].includes(command) ||
        positional.length > (command === 'generate' ? 2 : 1)
    ) {
        throw new Error('Usage: pumpkin-plugins-docs [plugin|root|actions|action-versions|generate MODULE] [--check]');
    }
    if (command === 'root' && !fs.existsSync(path.join(cwd, 'pnpm-workspace.yaml'))) {
        throw new Error('run `root` from the repository root');
    }
    let status;
    let where;
    if (command === 'generate') {
        const file = path.resolve(cwd, positional[1] ?? 'docs.ts');
        const config = await import(pathToFileURL(file).href);
        if (!Array.isArray(config.documents)) throw new Error(`${file} must export a documents array`);
        status = generateDocuments(config.documents, cwd, check);
        where = 'Custom documents';
    } else if (command === 'action-versions') {
        status = generateActionVersions(cwd, check);
        where = 'Action versions';
    } else if (command === 'actions') {
        status = generateActionReadmes(cwd, check);
        where = 'Action READMEs';
    } else if (command === 'root') {
        status = await generateRootReadme(cwd, check);
        where = 'README.md and component references';
    } else {
        status = await generatePluginReadme(cwd, check);
        where = 'README.md';
    }
    if (status === 'stale') {
        console.error(`${where}: out of date. Run \`pnpm readme\` and commit the result.`);
        process.exitCode = 1;
    } else console.log(`${where}: ${status}`);
} catch (err) {
    console.error(`pumpkin-plugins-docs: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
}
