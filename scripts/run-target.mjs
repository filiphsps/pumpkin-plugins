import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { readTarget, targetEnvironment } from './pumpkin-targets.mjs';

const root = path.resolve(import.meta.dirname, '..');
try {
    const args = process.argv.slice(2);
    if (args[0] === '--release-only') {
        args.shift();
        if (readTarget(root).name !== 'release') throw new Error('Packaging requires the release target');
        if (process.env.PUMPKIN_API_DIR || process.env.PUMPKIN_API_ENTRY || process.env.PUMPKIN_WIT_DIR) {
            throw new Error('Packaging does not accept API or WIT overrides');
        }
    }
    if (!args.length) throw new Error('Usage: run-target.mjs [--release-only] <turbo-task> [arguments...]');
    const env = await targetEnvironment(root);
    const target = readTarget(root, env.PUMPKIN_API_TARGET);
    console.log(
        `Pumpkin target ${target.name}: API ${target.api.ref}, WIT ${target.wit.ref}, server ${target.server.ref}`
    );
    const child = spawn(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['exec', 'turbo', 'run', ...args], {
        cwd: root,
        env,
        stdio: 'inherit',
        shell: process.platform === 'win32'
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
    child.once('error', (error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
    child.once('exit', (code, signal) => {
        process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1);
    });
} catch (error) {
    console.error(`pumpkin-target: ${error.message}`);
    process.exitCode = 1;
}
