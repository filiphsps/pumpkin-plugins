// Prints the canonical Pumpkin plugin name from its info module for the market publishing action.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const [pluginDir] = process.argv.slice(2);
if (!pluginDir) {
    console.error('usage: node scripts/market-plugin-name.mjs <plugin-dir>');
    process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'));
const infoFile = path.resolve(pluginDir, pkg.pumpkinPlugin?.info ?? 'src/info.ts');
const mod = await import(pathToFileURL(infoFile).href);
const name = (mod.info ?? mod.default)?.name;
if (typeof name !== 'string' || !name) throw new Error(`${infoFile} must export an info object with a name`);
console.log(name);
