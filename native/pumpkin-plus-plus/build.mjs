import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = import.meta.dirname;
const toolchain = fs
    .readFileSync(path.join(root, 'rust-toolchain.toml'), 'utf8')
    .match(/^channel\s*=\s*"([^"]+)"/m)?.[1];
if (!toolchain) throw new Error('Missing pinned Rust toolchain');
const locate = (tool) => execFileSync('rustup', ['which', '--toolchain', toolchain, tool], { encoding: 'utf8' }).trim();
const rustc = locate('rustc');
const version = execFileSync(rustc, ['--version'], { encoding: 'utf8' }).trim();
if (!version.startsWith(`rustc ${toolchain} `)) throw new Error(`Wrong compiler: ${version}`);
console.log(version);
execFileSync(
    locate('cargo'),
    [
        'build',
        '--locked',
        '--manifest-path',
        path.join(root, 'Cargo.toml'),
        '--lib',
        '--examples',
        ...process.argv.slice(2),
    ],
    {
        stdio: 'inherit',
        env: {
            ...process.env,
            RUSTC: rustc,
            RUSTDOC: locate('rustdoc'),
            RUST_MIN_STACK: process.env.RUST_MIN_STACK ?? '67108864',
            CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? '2',
        },
    },
);
