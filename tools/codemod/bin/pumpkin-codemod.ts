#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runCli } from '../src/cli.js';

if (
    process.argv[1] &&
    pathToFileURL(fs.realpathSync(path.resolve(process.argv[1]))).href ===
        pathToFileURL(fs.realpathSync(fileURLToPath(import.meta.url))).href
) {
    process.exitCode = await runCli();
}
