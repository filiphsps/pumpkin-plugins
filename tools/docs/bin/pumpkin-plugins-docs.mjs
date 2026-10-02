#!/usr/bin/env node
// pumpkin-plugins-docs [--check]        refresh the generated blocks of ./README.md (run in a plugin)
// pumpkin-plugins-docs root [--check]   refresh the packages tables of the repo's README.md
import * as fs from 'node:fs';
import * as path from 'node:path';
import { generatePluginReadme, generateRootReadme } from '../src/node.ts';

const args = process.argv.slice(2);
const check = args.includes('--check');
const root = args.includes('root');
const cwd = process.cwd();

try {
    if (root && !fs.existsSync(path.join(cwd, 'pnpm-workspace.yaml'))) {
        throw new Error('run `root` from the repository root');
    }
    const status = root ? await generateRootReadme(cwd, check) : await generatePluginReadme(cwd, check);
    const where = path.join(path.relative(process.cwd(), cwd) || '.', 'README.md');
    if (status === 'stale') {
        console.error(`${where} is out of date. Run \`pnpm readme\` and commit the result.`);
        process.exit(1);
    }
    console.log(`${where}: ${status}`);
} catch (err) {
    console.error(`pumpkin-plugins-docs: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
}
