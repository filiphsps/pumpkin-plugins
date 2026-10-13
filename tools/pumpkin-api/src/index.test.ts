import { expect, it } from 'vitest';
import { handleIpcMessage, metadata, Plugin } from './core.ts';

class TestPlugin extends Plugin {
    metadata() {
        return {
            name: 'test-plugin',
            version: '1.0.0',
            authors: [],
            description: 'A plugin used by the API unit tests.',
            dependencies: [],
            permissions: []
        };
    }
}

it('returns fallback metadata before a plugin is registered', () => {
    expect(metadata.getMetadata()).toEqual({
        name: 'unknown',
        version: '0.0.0',
        authors: [],
        description: 'No metadata',
        dependencies: [],
        permissions: []
    });
});

it('rejects IPC messages when a plugin does not provide a handler', () => {
    expect(() => new TestPlugin().handleIpcMessage('sender' as never, {} as never)).toThrowError(Error);
    expect(() => new TestPlugin().handleIpcMessage('sender' as never, {} as never)).toThrowError(
        'This plugin does not handle IPC messages'
    );
});

it('rejects IPC messages before a plugin is registered', () => {
    expect(() => handleIpcMessage('sender' as never, {} as never)).toThrowError(Error);
    expect(() => handleIpcMessage('sender' as never, {} as never)).toThrowError(
        'Cannot handle IPC messages before a plugin is registered'
    );
});
