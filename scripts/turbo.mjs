#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDefaultTurboFlags } from './turbo-args.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const turboCli = path.join(workspaceRoot, 'node_modules/turbo/bin/turbo');
const args = process.argv.slice(2);
const turboArgs = ['run', 'watch'].includes(args[0]) ? withDefaultTurboFlags(args) : args;
const result = spawnSync(process.execPath, [turboCli, ...turboArgs], {
    cwd: process.cwd(),
    stdio: 'inherit'
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
