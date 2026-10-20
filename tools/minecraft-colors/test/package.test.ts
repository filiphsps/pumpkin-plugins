import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(packageDirectory, 'package.json'), 'utf8'));
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');

it('loads the packed package in plain Node and resolves its types without a bundler', () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-colors-package-'));
    try {
        const tarballDirectory = path.join(temporaryDirectory, 'tarball');
        const consumerDirectory = path.join(temporaryDirectory, 'consumer');
        const installedDirectory = path.join(consumerDirectory, 'node_modules', manifest.name);
        fs.mkdirSync(tarballDirectory);
        fs.mkdirSync(installedDirectory, { recursive: true });

        execFileSync('pnpm', ['pack', '--pack-destination', tarballDirectory], {
            cwd: packageDirectory,
            stdio: 'pipe',
        });
        const [tarball] = fs.readdirSync(tarballDirectory);
        execFileSync('tar', [
            '-xzf',
            path.join(tarballDirectory, tarball),
            '-C',
            installedDirectory,
            '--strip-components=1',
        ]);

        const source = `import { ansi, color, type TextFormatter } from '${manifest.name}';\nconst formatter: TextFormatter = color.red;\nconsole.log(JSON.stringify([formatter('ok'), ansi.red('ok')]));\n`;
        fs.writeFileSync(path.join(consumerDirectory, 'package.json'), JSON.stringify({ type: 'module' }));
        fs.writeFileSync(path.join(consumerDirectory, 'main.ts'), source);
        fs.writeFileSync(
            path.join(consumerDirectory, 'main.mjs'),
            source.replace(', type TextFormatter', '').replace(': TextFormatter', ''),
        );
        fs.writeFileSync(
            path.join(consumerDirectory, 'tsconfig.json'),
            JSON.stringify({
                compilerOptions: { module: 'NodeNext', strict: true, noEmit: true, types: [] },
                files: ['main.ts'],
            }),
        );

        const typecheck = spawnSync(process.execPath, [tsc, '--project', consumerDirectory], { encoding: 'utf8' });
        expect(typecheck.status, `${typecheck.stdout}\n${typecheck.stderr}`).toBe(0);
        const run = spawnSync(process.execPath, ['main.mjs'], { cwd: consumerDirectory, encoding: 'utf8' });
        expect(run.status, run.stderr).toBe(0);
        expect(JSON.parse(run.stdout)).toEqual(['§cok§r', '\u001b[91mok\u001b[0m']);
    } finally {
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
}, 60_000);
