import type { ExtensionContext } from 'vscode';

/** The part of the Code Spell Checker extension API that this extension calls. */
export interface CodeSpellCheckerApi {
    /** Registers a CSpell configuration file with Code Spell Checker. */
    registerConfig(configPath: string): void | Promise<void>;
}

/** Registers the extension's packaged Minecraft dictionary configuration.
 *
 * @param context - VS Code extension context used to resolve the packaged configuration path.
 * @param spellChecker - Public API exported by Code Spell Checker.
 */
export async function registerDictionary(
    context: Pick<ExtensionContext, 'asAbsolutePath'>,
    spellChecker: CodeSpellCheckerApi,
): Promise<void> {
    await spellChecker.registerConfig(context.asAbsolutePath('cspell-ext.json'));
}
