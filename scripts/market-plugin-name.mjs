// Prints the canonical Pumpkin plugin name from its info module for the market publishing action.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Command } from 'commander';

const program = new Command()
    .name('market-plugin-name')
    .description('Print the canonical Pumpkin plugin name.')
    .argument('<plugin-dir>', 'Plugin package directory')
    .parse(process.argv);
const [pluginDir] = program.args;

const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'));
const infoFile = path.resolve(pluginDir, pkg.pumpkinPlugin?.info ?? 'src/info.ts');
const mod = await import(pathToFileURL(infoFile).href);
const name = (mod.info ?? mod.default)?.name;
if (typeof name !== 'string' || !name || /[\r\n\u2028\u2029]/u.test(name)) {
    throw new Error(`${infoFile} must export an info object with a nonempty single-line name`);
}
console.log(name);
