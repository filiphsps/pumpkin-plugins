import * as vscode from 'vscode';
import { type CodeSpellCheckerApi, registerDictionary } from './register-dictionary.js';

/** Activates the Minecraft dictionary in Code Spell Checker. */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const spellChecker = vscode.extensions.getExtension<CodeSpellCheckerApi>('streetsidesoftware.code-spell-checker');
    if (!spellChecker) throw new Error('Code Spell Checker is not installed');

    await registerDictionary(context, await spellChecker.activate());
}
