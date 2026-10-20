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
            permissions: [],
        };
    }
}

it('fails metadata requests before a plugin is registered', () => {
    expect(() => metadata.getMetadata()).toThrowError(/registerPlugin\(\)/);
});

it('rejects IPC messages when a plugin does not provide a handler', () => {
    expect(() => new TestPlugin().handleIpcMessage('sender' as never, {} as never)).toThrowError(/IPC/);
});

it('rejects IPC messages before a plugin is registered', () => {
    expect(() => handleIpcMessage('sender' as never, {} as never)).toThrowError(/registered/);
});
