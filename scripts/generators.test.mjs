import assert from 'node:assert/strict';
import { test } from 'node:test';

const { default: defineGenerators } = await import('../turbo/generators/config.ts');

function getPluginDescriptionValidator() {
    const generators = new Map();
    defineGenerators({
        setHelper() {},
        setGenerator(name, definition) {
            generators.set(name, definition);
        },
    });

    const descriptionPrompt = generators.get('plugin').prompts.find(({ name }) => name === 'description');
    return descriptionPrompt.validate;
}

test('plugin generator rejects multiline descriptions and accepts a one-line description', () => {
    const validate = getPluginDescriptionValidator();

    assert.equal(validate('First line\nSecond line'), 'Enter a one-line description');
    assert.equal(validate('First line\rSecond line'), 'Enter a one-line description');
    assert.equal(validate('A valid plugin description'), true);
});
