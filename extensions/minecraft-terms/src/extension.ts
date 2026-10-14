import * as vscode from 'vscode';
import { registerDictionary } from './register-dictionary.js';

interface CodeSpellCheckerApi {
    /** Registers a CSpell configuration file with Code Spell Checker. */
    registerConfig(configPath: string): void | Promise<void>;
}

/** Activates the Minecraft dictionary in Code Spell Checker. */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const spellChecker = vscode.extensions.getExtension<CodeSpellCheckerApi>('streetsidesoftware.code-spell-checker');
    if (!spellChecker) throw new Error('Code Spell Checker is not installed');

    await registerDictionary(context, await spellChecker.activate());
}
