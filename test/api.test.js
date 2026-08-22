import test from 'node:test';
import assert from 'node:assert/strict';

import {
    applyCarryover,
    avatarUrl,
    clearCarryover,
    currentAccounts,
    ensureCharacters,
    flushFeed,
    getSettings,
    listConnectionProfiles,
    loadFeed,
    runRefresh,
    saveFeedDebounced,
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
        const response = await handler(String(url), init);
        // Bodies are read as text now; let fixtures keep declaring them as objects.
        if (response && !response.text && response.json) {
            response.text = async () => JSON.stringify(await response.json());
        }
        return response;
    };
}

test.beforeEach(() => {
    current = makeContext();
    fetchCalls = [];
    fakeFetch(() => ({ ok: true, status: 200, json: async () => ({ path: '/user/files/twitterlike-feed.json' }) }));
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

function decodeUpload(init) {
    return Buffer.from(JSON.parse(init.body).data, 'base64').toString('utf8');
}

test('overlapping saves are serialised so an older upload cannot win', async () => {
    let started = 0;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const uploads = [];
    fakeFetch(async (url, init) => {
        started += 1;
        uploads.push(decodeUpload(init));
        if (started === 1) {
            await gate;
        }
        return { ok: true, status: 200, json: async () => ({ path: '/user/files/twitterlike-feed.json' }) };
    });

    const oldFeed = { version: 1, posts: [{ id: 'p1', body: 'older' }], interactions: [] };
    const newFeed = { version: 1, posts: [{ id: 'p2', body: 'newer' }], interactions: [] };
    saveFeedDebounced(oldFeed, 0);
    await new Promise(resolve => setTimeout(resolve, 5));
    saveFeedDebounced(newFeed, 0);
    await new Promise(resolve => setTimeout(resolve, 5));

    // The second write is queued behind the first and has not started yet.
    assert.equal(started, 1);
    release();
    await flushFeed();
    assert.equal(started, 2);
    assert.match(uploads[0], /older/);
    assert.match(uploads[1], /newer/);
});

test('a failed debounced save is retried by flushFeed instead of being lost', async () => {
    let failing = true;
    fakeFetch(() => (failing
        ? { ok: false, status: 500, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => ({ path: '/user/files/twitterlike-feed.json' }) }));

    saveFeedDebounced({ version: 1, posts: [{ id: 'p1', body: 'precious' }], interactions: [] }, 0);
    await new Promise(resolve => setTimeout(resolve, 5));
    await assert.rejects(() => flushFeed());

    failing = false;
    await flushFeed();
    const saved = fetchCalls.filter(([url]) => url === '/api/files/upload').at(-1);
    assert.match(decodeUpload(saved[1]), /precious/);
});

test('loadFeed returns an empty feed when nothing has been saved yet', async () => {
    const feed = await loadFeed();
    assert.deepEqual(feed, { version: 1, posts: [], interactions: [] });
    assert.equal(fetchCalls.length, 0);
});

test('a corrupt feed file fails closed instead of becoming a writable empty feed', async () => {
    updateSettings({ shards: ['/user/files/twitterlike-feed.json'] });
    // What a proxy or a signed-out session hands back instead of the file.
    fakeFetch(() => ({ ok: true, status: 200, text: async () => '<!DOCTYPE html><title>SillyBunny</title>' }));
    await assert.rejects(() => loadFeed(), /is not a timeline - it starts with "<!DOCTYPE html>/);
    assert.equal(fetchCalls.filter(([url]) => url === '/api/files/upload').length, 0);
});

test('an empty feed file starts over instead of locking the timeline shut', async () => {
    updateSettings({ shards: ['/user/files/twitterlike-feed.json'] });
    fakeFetch(() => ({ ok: true, status: 200, text: async () => '  \n' }));
    assert.deepEqual(await loadFeed(), { version: 1, posts: [], interactions: [] });
    assert.equal(fetchCalls.filter(([url]) => url === '/api/files/upload').length, 0);
});

test('an upload that answers with a web page says so instead of throwing a parser message', async () => {
    fakeFetch(() => ({ ok: true, status: 200, text: async () => '<!DOCTYPE html><title>Login</title>' }));
    await assert.rejects(() => writeFeed({ posts: [], interactions: [] }), /still signed in/);
});

test('a failed feed read reports the status and never uploads', async () => {
    updateSettings({ shards: ['/user/files/twitterlike-feed.json'] });
    fakeFetch(() => ({ ok: false, status: 500, json: async () => ({}) }));
    await assert.rejects(() => loadFeed(), /HTTP 500/);
    assert.equal(fetchCalls.filter(([url]) => url === '/api/files/upload').length, 0);
});

test('malformed rows are dropped instead of crashing renders later', async () => {
    updateSettings({ shards: ['/user/files/twitterlike-feed.json'] });
    fakeFetch(() => ({
        ok: true,
        status: 200,
        json: async () => ({
            posts: [
                null,
                { id: 'p1', authorKey: 'persona:me.png', body: 'keep me', createdAt: 100 },
                { id: 'p2', body: 42, createdAt: 'nope' },
                { id: 'p1', authorKey: 'x', body: 'duplicate id', createdAt: 1 },
                { id: 'p3', authorKey: 'a', body: 'ok', createdAt: 2, poll: { question: '?', options: [{ text: 'one' }] } },
            ],
            interactions: [
                { id: 'i1', postId: 'gone', type: 'like', actorKey: 'a', createdAt: 1 },
                { id: 'i2', postId: 'p1', type: 'sparkle', actorKey: 'a', createdAt: 1 },
                { id: 'i3', postId: 'p1', type: 'reply', actorKey: 'a', content: 'hi', createdAt: 2, actorSnapshot: { name: 'A' } },
                { id: 'i3', postId: 'p1', type: 'reply', actorKey: 'b', content: 'dup', createdAt: 3 },
            ],
        }),
    }));
    const feed = await loadFeed();
    assert.deepEqual(feed.posts.map(post => post.id), ['p1', 'p3']);
    const [post] = feed.posts;
    assert.equal(post.body, 'keep me'); // a numeric or missing body never survives as a number
    assert.equal(feed.posts[1].poll, null); // a poll that cannot render is dropped, not the post
    assert.deepEqual(feed.interactions.map(item => item.id), ['i3']);
    assert.equal(feed.interactions[0].actorSnapshot.name, 'A');
});

test('loadFeed busts the cache, because the file is overwritten in place', async () => {
    updateSettings({ shards: ['/user/files/twitterlike-feed.json'] });
    fakeFetch(() => ({
        ok: true,
        status: 200,
        json: async () => ({
            posts: [{ id: 'p1', authorKey: 'character:ada.png', body: 'hello', createdAt: 5, authorSnapshot: { name: 'Ada' } }],
            interactions: [],
        }),
    }));
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

test('a failed save leaves the timeline and lastRefreshAt untouched', async () => {
    current.nextResponse = GOOD_BATCH;
    updateSettings({ profiles: { 'character:ada.png': { handle: 'ada' }, 'character:bo.png': { handle: 'bo' } } });
    fakeFetch(() => ({ ok: false, status: 500, json: async () => ({}) }));
    const feed = emptyFeed();
    await assert.rejects(() => runRefresh({ feed }), /Could not save/);
    assert.equal(feed.posts.length, 0);
    assert.equal(feed.interactions.length, 0);
    assert.ok(!(getSettings().lastRefreshAt > 0));
});

test('a follow made while the model thinks survives the refresh commit', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    current.generateRaw = async () => {
        await gate;
        return JSON.stringify({ posts: [], interactions: [], follows: [{ actorHandle: 'ada', targetHandle: 'bo' }] });
    };
    updateSettings({ profiles: { 'character:ada.png': { handle: 'ada' }, 'character:bo.png': { handle: 'bo' } } });
    const refresh = runRefresh({ feed: emptyFeed() });
    await new Promise(resolve => setTimeout(resolve, 5));
    updateSettings({ follows: { 'character:bo.png': ['persona:me.png'] } });
    release();
    await refresh;

    const follows = getSettings().follows;
    assert.deepEqual(follows['character:ada.png'], ['character:bo.png']);
    assert.deepEqual(follows['character:bo.png'], ['persona:me.png']);
});

test('a model image prompt cannot inject /imagine flags', async () => {
    current.nextResponse = JSON.stringify({
        posts: [{ authorHandle: 'ada', content: 'look', imagePrompt: 'quiet=false gallery=true "evil"' }],
        interactions: [],
        follows: [],
    });
    current.nextImage = '/user/images/cat.png';
    updateSettings({
        images: { enabled: true, perRefresh: 2 },
        profiles: { 'character:ada.png': { handle: 'ada' }, 'character:bo.png': { handle: 'bo' } },
    });
    await runRefresh({ feed: emptyFeed() });
    const command = current.calls.find(call => call[0] === 'slash')[1];
    assert.match(command, /^\/imagine quiet=true gallery=false "/);
    assert.equal(command.endsWith('\\"evil\\""'), true);
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
    // setExtensionPrompt(key, value, position, depth, ...): the clear must mirror the
    // write on every argument that positions or scopes the prompt.
    assert.match(wrote[2], /Recent Social Media Activity/);
    assert.equal(cleared[2], '');
    assert.equal(wrote[1], cleared[1]);
    assert.equal(wrote[3], cleared[3]);
    assert.equal(wrote[4], cleared[4]);
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
