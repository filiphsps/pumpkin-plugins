import * as fs from 'node:fs';
import * as path from 'node:path';

const extensionRoot = path.resolve(import.meta.dirname, '..');
const repositoryRoot = path.resolve(extensionRoot, '../..');
const source = path.join(repositoryRoot, 'tools/cspell-dict-minecraft/minecraft.txt');
const destination = path.join(extensionRoot, 'dist/minecraft.txt');

if (!fs.existsSync(source)) throw new Error(`Minecraft dictionary source is missing: ${source}`);
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.copyFileSync(source, destination);
console.log(`Copied Minecraft dictionary to ${path.relative(repositoryRoot, destination)}`);
