// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: Tests set and restore GITHUB_TOKEN explicitly.
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { loadTeamMembers } from './team-data.mjs';

const originalFetch = globalThis.fetch;
const originalToken = process.env.GITHUB_TOKEN;
const originalWarn = console.warn;

afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalToken;
    console.warn = originalWarn;
});

function contributor(login, nodeId = `NODE_${login}`, overrides = {}) {
    return {
        login,
        node_id: nodeId,
        type: 'User',
        avatar_url: `https://avatars.example.test/${login}`,
        html_url: `https://github.com/${login}`,
        contributions: 7,
        ...overrides
    };
}

function response(body, { status = 200, ok = true } = {}) {
    return { status, ok, json: async () => body };
}

function graphQLResponse(nodes) {
    return response({ data: { nodes } });
}

describe('Team data loader', () => {
    it('batches human names for a contributor page and filters bots', async () => {
        process.env.GITHUB_TOKEN = 'test-token';
        const calls = [];
        globalThis.fetch = async (url, options) => {
            calls.push({ url: String(url), options });
            if (String(url).includes('/contributors?')) {
                return response([
                    contributor('alice'),
                    contributor('bob'),
                    contributor('renovate[bot]'),
                    contributor('service', 'NODE_SERVICE', { type: 'Bot' })
                ]);
            }
            if (String(url) === 'https://api.github.com/graphql') {
                return graphQLResponse([
                    { login: 'alice', name: 'Alice Example' },
                    { login: 'bob', name: null }
                ]);
            }
            assert.fail(`unexpected GitHub request: ${url}`);
        };

        const members = await loadTeamMembers();

        assert.equal(calls.length, 2);
        assert.match(calls[0].url, /\/contributors\?per_page=100&page=1$/);
        assert.equal(calls[1].url, 'https://api.github.com/graphql');
        assert.equal(calls[1].options.method, 'POST');
        assert.equal(calls[1].options.headers['Content-Type'], 'application/json');
        assert.deepEqual(JSON.parse(calls[1].options.body).variables.ids, ['NODE_alice', 'NODE_bob']);
        assert.equal(calls[1].options.headers.Authorization, 'Bearer test-token');
        assert.deepEqual(
            members.map(({ login, name }) => ({ login, name })),
            [
                { login: 'alice', name: 'Alice Example' },
                { login: 'bob', name: 'bob' }
            ]
        );
        assert.equal(members[0].contributions, 7);
        assert.equal(members[0].avatar, 'https://avatars.example.test/alice');
        assert.deepEqual(members[0].links, [{ icon: 'github', link: 'https://github.com/alice' }]);
    });

    it('sends one name batch for each paginated contributor page', async () => {
        process.env.GITHUB_TOKEN = 'test-token';
        const firstPage = Array.from({ length: 100 }, (_, index) => contributor(`user-${index}`));
        const secondPage = [contributor('last-user')];
        const calls = [];
        globalThis.fetch = async (url, options) => {
            calls.push({ url: String(url), options });
            if (String(url).includes('/contributors?')) {
                return response(
                    calls.filter(({ url: calledUrl }) => calledUrl.includes('/contributors?')).length === 1
                        ? firstPage
                        : secondPage
                );
            }
            if (String(url) === 'https://api.github.com/graphql') {
                return graphQLResponse([]);
            }
            assert.fail(`unexpected GitHub request: ${url}`);
        };

        const members = await loadTeamMembers();
        const graphqlCalls = calls.filter(({ url }) => url === 'https://api.github.com/graphql');

        assert.equal(members.length, 101);
        assert.equal(graphqlCalls.length, 2);
        assert.deepEqual(
            graphqlCalls.map(({ options }) => JSON.parse(options.body).variables.ids.length),
            [100, 1]
        );
        assert.equal(
            calls.some(({ url }) => /\/users\//.test(url)),
            false
        );
    });

    it('uses logins without a token and makes no profile requests', async () => {
        delete process.env.GITHUB_TOKEN;
        const calls = [];
        globalThis.fetch = async (url) => {
            calls.push(String(url));
            return response([contributor('alice')]);
        };

        const members = await loadTeamMembers();

        assert.equal(members[0].name, 'alice');
        assert.equal(calls.length, 1);
        assert.equal(
            calls.some((url) => url.includes('/graphql') || /\/users\//.test(url)),
            false
        );
    });

    it('falls back to logins when GraphQL enrichment fails', async () => {
        process.env.GITHUB_TOKEN = 'test-token';
        console.warn = () => {};
        const calls = [];
        globalThis.fetch = async (url) => {
            calls.push(String(url));
            if (String(url).includes('/contributors?')) return response([contributor('alice')]);
            return response({}, { status: 502, ok: false });
        };

        const members = await loadTeamMembers();

        assert.equal(members[0].name, 'alice');
        assert.equal(calls.length, 2);
        assert.equal(
            calls.some((url) => /\/users\//.test(url)),
            false
        );
    });
});
