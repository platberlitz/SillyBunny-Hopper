import test from 'node:test';
import assert from 'node:assert/strict';

import {
    applyCarryover,
    assertCapabilities,
    avatarUrl,
    clearCarryover,
    currentAccounts,
    ensureCharacters,
    getSettings,
    listConnectionProfiles,
    loadFeed,
    runRefresh,
    updateSettings,
    writeFeed,
} from '../src/api.js';
import { SETTINGS_KEY } from '../src/core.js';

let current;
let fetchCalls;
globalThis.SillyTavern = { getContext: () => current };

function makeContext(overrides = {}) {
    const calls = [];
    const characters = [
        { avatar: 'ada.png', name: 'Ada', data: { description: 'a mathematician' } },
        { avatar: 'bo.png', name: 'Bo', data: { description: 'a courier' } },
    ];
    const context = {
        calls,
        characters: [],
        characterId: 0,
        groups: [],
        groupId: null,
        name1: 'Me',
        userAvatar: 'me.png',
        powerUserSettings: { persona_description: 'a person' },
        extensionSettings: { [SETTINGS_KEY]: { invited: ['ada.png', 'bo.png'] }, disabledExtensions: [] },
        eventTypes: { APP_READY: 'app_ready', CHAT_CHANGED: 'chat_changed' },
        uuidv4: (() => { let n = 0; return () => `u${++n}`; })(),
        isMobile: () => false,
        async getCharacters() {
            calls.push(['getCharacters']);
            context.characters = characters;
        },
        getThumbnailUrl(type, file) {
            return `/thumbnail?type=${type}&file=${file}`;
        },
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        saveSettingsDebounced() { calls.push(['saveSettingsDebounced']); },
        setExtensionPrompt(...args) { calls.push(['setExtensionPrompt', ...args]); },
        async generateRaw(options) { calls.push(['generateRaw', options]); return context.nextResponse ?? '{}'; },
        async getTokenCountAsync(text) { return Math.ceil(text.length / 4); },
        async executeSlashCommandsWithOptions(command) {
            calls.push(['slash', command]);
            return { pipe: context.nextImage ?? '' };
        },
        ...overrides,
    };
    return context;
}

function fakeFetch(handler) {
    globalThis.fetch = async (url, init) => {
        fetchCalls.push([String(url), init]);
        return handler(String(url), init);
    };
}

test.beforeEach(() => {
    current = makeContext();
    fetchCalls = [];
    fakeFetch(() => ({ ok: true, status: 200, json: async () => ({ path: '/user/files/twitterlike-feed.json' }) }));
});

// --- capabilities ---------------------------------------------------------

test('assertCapabilities names what is missing instead of failing later', () => {
    current = makeContext({ generateRaw: undefined });
    assert.throws(() => assertCapabilities(), /missing generateRaw/);
    current = makeContext({ eventTypes: { APP_READY: 'app_ready' } });
    assert.throws(() => assertCapabilities(), /eventTypes.CHAT_CHANGED/);
    current = makeContext();
    assert.doesNotThrow(() => assertCapabilities());
});

// --- settings -------------------------------------------------------------

test('getSettings normalises in place so a hand-edited blob self-heals', () => {
    current.extensionSettings[SETTINGS_KEY] = { quotas: { posts: 9999 } };
    const settings = getSettings();
    assert.equal(settings.quotas.posts, 100);
    assert.equal(current.extensionSettings[SETTINGS_KEY].quotas.posts, 100);
});

test('updateSettings merges and asks the host to save', () => {
    updateSettings({ ambient: true });
    assert.equal(getSettings().ambient, true);
    assert.deepEqual(getSettings().invited, ['ada.png', 'bo.png']);
    assert.ok(current.calls.some(call => call[0] === 'saveSettingsDebounced'));
});

// --- characters -----------------------------------------------------------

test('ensureCharacters refreshes before the list is trusted', async () => {
    assert.deepEqual(current.characters, []);
    const characters = await ensureCharacters();
    assert.equal(characters.length, 2);
    assert.ok(current.calls.some(call => call[0] === 'getCharacters'));
});

test('currentAccounts includes the persona and only invited characters', async () => {
    updateSettings({ invited: ['ada.png'] });
    const accounts = await currentAccounts();
    assert.deepEqual(accounts.map(a => a.key), ['persona:me.png', 'character:ada.png']);
});

test('avatarUrl uses the persona thumbnail type for the persona', async () => {
    const accounts = await currentAccounts();
    const persona = accounts.find(a => a.kind === 'persona');
    const character = accounts.find(a => a.kind === 'character');
    assert.match(avatarUrl(persona), /type=persona&file=me\.png/);
    assert.match(avatarUrl(character), /type=avatar&file=ada\.png/);
    assert.equal(avatarUrl({ kind: 'ambient' }), '');
});

test('avatarUrl asks for the smaller image on mobile', async () => {
    current.isMobile = () => true;
    const accounts = await currentAccounts();
    assert.match(avatarUrl(accounts[0]), /preset=mobile/);
});

// --- storage --------------------------------------------------------------

test('the feed is written to the files endpoint, never into settings', async () => {
    const feed = { version: 1, posts: [{ id: 'p1', body: 'hello' }], interactions: [] };
    await writeFeed(feed);

    const [url, init] = fetchCalls[0];
    assert.equal(url, '/api/files/upload');
    const body = JSON.parse(init.body);
    assert.equal(body.name, 'twitterlike-feed.json');
    assert.match(Buffer.from(body.data, 'base64').toString('utf8'), /hello/);

    const stored = JSON.stringify(current.extensionSettings[SETTINGS_KEY]);
    assert.doesNotMatch(stored, /hello/);
    assert.deepEqual(getSettings().shards, ['/user/files/twitterlike-feed.json']);
});

test('writeFeed reports a failed save instead of pretending it worked', async () => {
    fakeFetch(() => ({ ok: false, status: 500, json: async () => ({}) }));
    await assert.rejects(() => writeFeed({ posts: [], interactions: [] }), /Could not save the feed \(500\)/);
});

test('loadFeed returns an empty feed when nothing has been saved yet', async () => {
    const feed = await loadFeed();
    assert.deepEqual(feed, { version: 1, posts: [], interactions: [] });
    assert.equal(fetchCalls.length, 0);
});

test('loadFeed survives a corrupt or missing feed file', async () => {
    updateSettings({ shards: ['/user/files/twitterlike-feed.json'] });
    fakeFetch(() => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }));
    assert.deepEqual(await loadFeed(), { version: 1, posts: [], interactions: [] });
});

test('loadFeed busts the cache, because the file is overwritten in place', async () => {
    updateSettings({ shards: ['/user/files/twitterlike-feed.json'] });
    fakeFetch(() => ({ ok: true, status: 200, json: async () => ({ posts: [{ id: 'p1' }], interactions: [] }) }));
    const feed = await loadFeed();
    assert.equal(feed.posts.length, 1);
    assert.match(fetchCalls[0][0], /\?t=\d+/);
    assert.equal(fetchCalls[0][1].cache, 'no-store');
});

// --- connections ----------------------------------------------------------

test('listConnectionProfiles is empty rather than fatal when Connection Manager is off', () => {
    assert.deepEqual(listConnectionProfiles(), []);
    current.ConnectionManagerRequestService = {
        getSupportedProfiles() { throw new Error('Connection Manager is not available'); },
    };
    assert.deepEqual(listConnectionProfiles(), []);
});

// --- refresh --------------------------------------------------------------

const GOOD_BATCH = JSON.stringify({
    posts: [{ tempId: 't1', authorHandle: 'ada', content: 'first post' }],
    interactions: [{ actorHandle: 'bo', type: 'reply', targetTempId: 't1', content: 'nice one' }],
    follows: [],
});

function emptyFeed() {
    return { version: 1, posts: [], interactions: [] };
}

test('a refresh with no cast explains itself rather than calling the model', async () => {
    updateSettings({ invited: [], ambient: false });
    await assert.rejects(() => runRefresh({ feed: emptyFeed() }), /Invite a character first/);
    assert.equal(current.calls.filter(call => call[0] === 'generateRaw').length, 0);
});

test('a refresh stores posts and interactions and stamps lastRefreshAt', async () => {
    current.nextResponse = GOOD_BATCH;
    updateSettings({ profiles: { 'character:ada.png': { handle: 'ada' }, 'character:bo.png': { handle: 'bo' } } });
    const feed = emptyFeed();
    const result = await runRefresh({ feed });
    assert.equal(result.posts.length, 1);
    assert.equal(result.interactions.length, 1);
    assert.equal(feed.posts.length, 1);
    assert.ok(getSettings().lastRefreshAt > 0);
});

test('a saved connection profile is preferred over generateRaw', async () => {
    const sent = [];
    current.ConnectionManagerRequestService = {
        getSupportedProfiles: () => [{ id: 'p1', name: 'cheap' }],
        async sendRequest(profileId, messages, maxTokens) {
            sent.push({ profileId, messages, maxTokens });
            return { content: GOOD_BATCH };
        },
    };
    updateSettings({
        profileId: 'p1',
        profiles: { 'character:ada.png': { handle: 'ada' }, 'character:bo.png': { handle: 'bo' } },
    });
    await runRefresh({ feed: emptyFeed() });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].profileId, 'p1');
    assert.ok(Array.isArray(sent[0].messages));
    assert.equal(sent[0].messages[0].role, 'system');
    assert.equal(current.calls.filter(call => call[0] === 'generateRaw').length, 0);
});

test('malformed JSON is retried once with a correction, then reported', async () => {
    let attempts = 0;
    current.generateRaw = async () => {
        attempts += 1;
        return attempts === 1 ? 'sorry, I cannot do that' : GOOD_BATCH;
    };
    updateSettings({ profiles: { 'character:ada.png': { handle: 'ada' }, 'character:bo.png': { handle: 'bo' } } });
    const result = await runRefresh({ feed: emptyFeed() });
    assert.equal(attempts, 2);
    assert.equal(result.posts.length, 1);

    current.generateRaw = async () => 'still not JSON';
    await assert.rejects(() => runRefresh({ feed: emptyFeed() }), /did not return usable JSON/);
});

test('a failed image still publishes a clean text-only post', async () => {
    current.nextResponse = JSON.stringify({
        posts: [{ authorHandle: 'ada', content: 'look at this', imagePrompt: 'a cat' }],
        interactions: [],
        follows: [],
    });
    current.nextImage = '';
    updateSettings({
        images: { enabled: true, perRefresh: 2 },
        profiles: { 'character:ada.png': { handle: 'ada' }, 'character:bo.png': { handle: 'bo' } },
    });
    const result = await runRefresh({ feed: emptyFeed() });
    assert.equal(result.posts.length, 1);
    assert.equal(result.posts[0].image, null);
    assert.ok(current.calls.some(call => call[0] === 'slash' && call[1].includes('quiet=true')));
});

test('a successful image is attached to the post', async () => {
    current.nextResponse = JSON.stringify({
        posts: [{ authorHandle: 'ada', content: 'look at this', imagePrompt: 'a cat' }],
        interactions: [],
        follows: [],
    });
    current.nextImage = '/user/images/cat.png';
    updateSettings({
        images: { enabled: true, perRefresh: 2 },
        profiles: { 'character:ada.png': { handle: 'ada' }, 'character:bo.png': { handle: 'bo' } },
    });
    const result = await runRefresh({ feed: emptyFeed() });
    assert.equal(result.posts[0].image.url, '/user/images/cat.png');
});

test('follows returned by a refresh are stored against the actor', async () => {
    current.nextResponse = JSON.stringify({
        posts: [], interactions: [], follows: [{ actorHandle: 'ada', targetHandle: 'bo' }],
    });
    updateSettings({ profiles: { 'character:ada.png': { handle: 'ada' }, 'character:bo.png': { handle: 'bo' } } });
    await runRefresh({ feed: emptyFeed() });
    assert.deepEqual(getSettings().follows['character:ada.png'], ['character:bo.png']);
});

// --- carryover ------------------------------------------------------------

function setExtensionPromptCalls() {
    return current.calls.filter(call => call[0] === 'setExtensionPrompt');
}

test('carryover off writes an empty prompt rather than leaving a stale one', async () => {
    updateSettings({ carry: { enabled: false } });
    const block = await applyCarryover({ posts: [{ id: 'p1', authorKey: 'character:ada.png', body: 'hi', createdAt: Date.now() }], interactions: [] });
    assert.equal(block, '');
    const [call] = setExtensionPromptCalls();
    assert.equal(call[2], '');
});

test('clearCarryover uses the same key, position and depth as the write', async () => {
    updateSettings({ carry: { enabled: true, hours: 48, items: 8, depth: 1 } });
    await applyCarryover({
        posts: [{ id: 'p1', authorKey: 'character:ada.png', body: 'hi', createdAt: Date.now(), authorSnapshot: { name: 'Ada' } }],
        interactions: [],
    });
    clearCarryover();
    const calls = setExtensionPromptCalls();
    const wrote = calls[0];
    const cleared = calls[calls.length - 1];
    assert.match(wrote[2], /Recent Social Media Activity/);
    assert.equal(cleared[2], '');
    assert.equal(wrote[1], cleared[1]);
    assert.equal(wrote[3], cleared[3]);
});

test('carryover only mentions characters who are in the current chat', async () => {
    updateSettings({ carry: { enabled: true, hours: 48, items: 8, depth: 1 } });
    await ensureCharacters();
    current.characterId = 0; // Ada
    const now = Date.now();
    const block = await applyCarryover({
        posts: [
            { id: 'p1', authorKey: 'character:ada.png', body: 'ada speaks', createdAt: now, authorSnapshot: { name: 'Ada' } },
            { id: 'p2', authorKey: 'character:bo.png', body: 'bo speaks', createdAt: now, authorSnapshot: { name: 'Bo' } },
        ],
        interactions: [],
    });
    assert.match(block, /ada speaks/);
    assert.doesNotMatch(block, /bo speaks/);
});

test('carryover with nothing recent clears instead of writing an empty header', async () => {
    updateSettings({ carry: { enabled: true, hours: 1, items: 8, depth: 1 } });
    const block = await applyCarryover({
        posts: [{ id: 'p1', authorKey: 'character:ada.png', body: 'ancient', createdAt: 0 }],
        interactions: [],
    });
    assert.equal(block, '');
});
