#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Argument, Command } from 'commander';
import {
    generateActionReadmes,
    generateActionVersions,
    generateDocuments,
    generatePluginReadme,
    generateRootReadme
} from '../src/node.ts';

const program = new Command()
    .name('pumpkin-plugins-docs')
    .description('Generate or check plugin, action, and repository documentation.')
    .addArgument(
        new Argument('[command]', 'Documentation target')
            .choices(['plugin', 'root', 'generate', 'actions', 'action-versions'])
            .default('plugin')
    )
    .addArgument(new Argument('[module]', 'Custom documents module; used with generate'))
    .option('--check', 'Check generated documentation without writing files')
    .parse(process.argv);
const [command, module] = program.args;
const check = program.opts().check ?? false;
const cwd = process.cwd();

try {
    if (module && command !== 'generate') throw new Error('A documents module is only accepted with `generate`');
    if (command === 'root' && !fs.existsSync(path.join(cwd, 'pnpm-workspace.yaml'))) {
        throw new Error('run `root` from the repository root');
    }
    let status;
    let where;
    if (command === 'generate') {
        const file = path.resolve(cwd, module ?? 'docs.ts');
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
