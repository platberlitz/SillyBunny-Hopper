import test from 'node:test';
import assert from 'node:assert/strict';

import {
    applyCarryover,
    avatarUrl,
    clearCarryover,
    createSession,
    currentAccounts,
    ensureCharacters,
    ensureActiveSession,
    flushFeed,
    getScenarioNotes,
    getSession,
    getSettings,
    listConnectionProfiles,
    loadFeed,
    runRefresh,
    saveFeedDebounced,
    selectSession,
    updateSettings,
    updateSession,
    writeFeed,
    generatePersonaProfile,
    deleteSession,
    regenerateAllProfiles,
    generatePostImage,
    uploadImage,
    clearStrangers,
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
        powerUserSettings: {
            personas: { 'me.png': 'Me' },
            persona_descriptions: {
                'me.png': {
                    description: 'a person',
                    appendices: [{ id: 'beach', name: 'Beach trip', description: 'Currently on holiday.' }],
                },
            },
        },
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
        async executeSlashCommandsWithOptions(command, options) {
            calls.push(['slash', command, options]);
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
    const session = ensureActiveSession();
    updateSession(session.id, { invited: ['ada.png'] });
    const accounts = await currentAccounts();
    assert.deepEqual(accounts.map(a => a.key), ['persona:me.png', 'character:ada.png']);
});

test('the migrated timeline binds once to the current persona', () => {
    const session = ensureActiveSession();
    assert.equal(session.id, 'legacy');
    assert.equal(session.personaId, 'me.png');
    assert.equal(getSettings().activeSessionByPersona['me.png'], 'legacy');
});

test('timeline persona profile and Scenario Notes are session-local', async () => {
    const session = ensureActiveSession();
    assert.deepEqual(getScenarioNotes('me.png').map(note => note.id), ['beach']);
    updateSession(session.id, {
        scenarioNoteIds: ['beach'],
        personaProfile: { name: 'M.', handle: 'm_here', bio: 'quiet account', location: 'Away' },
    });
    const persona = (await currentAccounts(session.id)).find(account => account.kind === 'persona');
    assert.equal(persona.name, 'M.');
    assert.equal(persona.handle, 'm_here');
    assert.equal(persona.bio, 'quiet account');
    assert.match(persona.description, /\(Beach trip\)\nCurrently on holiday/);
    assert.equal(current.powerUserSettings.persona_descriptions['me.png'].activeAppendices, undefined);
});

test('active timeline choice is remembered independently per persona', () => {
    current.powerUserSettings.personas['other.png'] = 'Other';
    current.powerUserSettings.persona_descriptions['other.png'] = { description: 'another person' };
    const mine = ensureActiveSession('me.png');
    const other = createSession({ name: 'Other timeline', personaId: 'other.png' });
    assert.equal(ensureActiveSession('other.png').id, other.id);
    assert.equal(ensureActiveSession('me.png').id, mine.id);
});

test('selecting a missing persona leaves the timeline owner and active choice unchanged', async () => {
    const session = ensureActiveSession();
    const before = getSettings();
    await assert.rejects(() => selectSession(session.id, { personaId: 'missing.png' }), /no longer available/);
    assert.equal(getSession(session.id).personaId, 'me.png');
    assert.equal(getSettings().activeSessionId, before.activeSessionId);
    assert.deepEqual(getSettings().activeSessionByPersona, before.activeSessionByPersona);
});

test('a failed persona switch preserves concurrent session updates', async () => {
    current.powerUserSettings.personas['other.png'] = 'Other';
    const session = ensureActiveSession();
    const switching = selectSession(session.id, { personaId: 'other.png' });
    updateSession(session.id, { feedPath: '/user/files/just-saved.json' });

    await assert.rejects(() => switching, /host could not switch/);
    assert.equal(getSession(session.id).personaId, 'me.png');
    assert.equal(getSession(session.id).feedPath, '/user/files/just-saved.json');
});

test('avatarUrl uses the persona thumbnail type for the persona', async () => {
    const accounts = await currentAccounts();
    const persona = accounts.find(a => a.kind === 'persona');
    const character = accounts.find(a => a.kind === 'character');
    assert.match(avatarUrl(persona), /type=persona&file=me\.png/);
    assert.match(avatarUrl(character), /type=avatar&file=ada\.png/);
    assert.equal(avatarUrl({ kind: 'ambient' }), '');
    assert.equal(avatarUrl({ kind: 'character' }), '', 'a historical snapshot without entityId uses initials');
});

test('avatarUrl asks for the smaller image on mobile', async () => {
    current.isMobile = () => true;
    const accounts = await currentAccounts();
    assert.match(avatarUrl(accounts[0]), /preset=mobile/);
});

// --- storage --------------------------------------------------------------

test('pictures come from Quick Image Gen when its /qig advertises quiet=true, else from /imagine', async () => {
    current.SlashCommandParser = { commands: { qig: { namedArgumentList: [{ name: 'mode' }, { name: 'quiet' }] } } };
    current.nextImage = '/user/images/qig/cat.png';
    assert.equal(await generatePostImage('a cat, "tabby"'), '/user/images/qig/cat.png');
    assert.match(current.calls.find(call => call[0] === 'slash')[1], /^\/qig quiet=true mode=direct "a cat, \\"tabby\\""$/);
    current.calls.length = 0;
    current.nextImage = 'QIG failed: no provider configured';
    assert.equal(await generatePostImage('a cat'), '', 'a status line is not a picture');
    current.calls.length = 0;
    current.SlashCommandParser = { commands: { qig: { namedArgumentList: [{ name: 'mode' }] } } };
    current.nextImage = '/user/images/sd/cat.png';
    assert.equal(await generatePostImage('a cat'), '/user/images/sd/cat.png');
    assert.match(current.calls.find(call => call[0] === 'slash')[1], /^\/imagine quiet=true gallery=false "a cat"$/);
    delete current.SlashCommandParser;
});

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

test('each new timeline writes to its own feed file', async () => {
    const legacy = ensureActiveSession();
    const second = createSession({ name: 'Close friends', personaId: 'me.png', invited: ['ada.png'] });
    fakeFetch((_url, init) => {
        const { name } = JSON.parse(init.body);
        return { ok: true, status: 200, json: async () => ({ path: `/user/files/${name}` }) };
    });
    await writeFeed({ posts: [], interactions: [] }, legacy.id);
    await writeFeed({ posts: [], interactions: [] }, second.id);
    const names = fetchCalls.map(([, init]) => JSON.parse(init.body).name);
    assert.equal(names[0], 'twitterlike-feed.json');
    assert.match(names[1], /^twitterlike-feed-u1\.json$/);
    assert.notEqual(getSession(legacy.id).feedPath, getSession(second.id).feedPath);
});

test('deleteSession removes the feed file, the session and any pointer at it', async () => {
    const legacy = ensureActiveSession();
    const second = createSession({ name: 'Close friends', personaId: 'me.png', invited: ['ada.png'] });
    fakeFetch((url, init) => {
        if (url === '/api/files/upload') {
            const { name } = JSON.parse(init.body);
            return { ok: true, status: 200, json: async () => ({ path: `/user/files/${name}` }) };
        }
        return { ok: true, status: 200, json: async () => ({}) };
    });
    await writeFeed({ posts: [], interactions: [] }, second.id);
    assert.equal(getSettings().activeSessionId, second.id);
    await deleteSession(second.id);
    const deletion = fetchCalls.find(([url]) => url === '/api/files/delete');
    assert.equal(JSON.parse(deletion[1].body).path, '/user/files/twitterlike-feed-u1.json');
    assert.equal(getSession(second.id), null);
    assert.notEqual(getSettings().activeSessionId, second.id);
    assert.ok(!Object.values(getSettings().activeSessionByPersona).includes(second.id));
    assert.ok(getSession(legacy.id), 'other timelines stay');
    // A timeline that was never saved has no file to delete.
    const third = createSession({ name: 'Empty', personaId: 'me.png' });
    const before = fetchCalls.length;
    await deleteSession(third.id);
    assert.equal(fetchCalls.length, before);
    assert.equal(getSession(third.id), null);
    await assert.rejects(() => deleteSession('nope'), /no longer exists/);
});

test('deleteSession removes local state without deleting an untrusted path', async () => {
    const session = ensureActiveSession();
    updateSession(session.id, { feedPath: '/user/files/unrelated.json' });
    await deleteSession(session.id);
    assert.equal(getSession(session.id), null);
    assert.equal(fetchCalls.length, 0);
});

test('deleting the final v2 timeline leaves no resurrected legacy state', async () => {
    const only = ensureActiveSession();
    await deleteSession(only.id);
    assert.deepEqual(getSettings().sessions, {});
    const fresh = ensureActiveSession();
    assert.notEqual(fresh.id, 'legacy');
    assert.deepEqual(fresh.invited, []);
});

test('different timeline sessions derive different character casts', async () => {
    const first = ensureActiveSession();
    updateSession(first.id, { invited: ['ada.png'] });
    const second = createSession({ personaId: 'me.png', invited: ['bo.png'] });
    assert.deepEqual((await currentAccounts(first.id)).filter(a => a.kind === 'character').map(a => a.entityId), ['ada.png']);
    assert.deepEqual((await currentAccounts(second.id)).filter(a => a.kind === 'character').map(a => a.entityId), ['bo.png']);
});

test('writeFeed reports a failed save instead of pretending it worked', async () => {
    fakeFetch(() => ({ ok: false, status: 500, json: async () => ({}) }));
    await assert.rejects(() => writeFeed({ posts: [], interactions: [] }), /Could not save the feed \(500\)/);
    await flushFeed();
    assert.equal(fetchCalls.length, 1, 'a failed transactional write must not silently retry later');
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

test('a failed pending edit is made durable before a newer direct save', async () => {
    let started = 0;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const uploads = [];
    fakeFetch(async (_url, init) => {
        started += 1;
        uploads.push(decodeUpload(init));
        if (started === 1) {
            await gate;
            return { ok: false, status: 500, json: async () => ({}) };
        }
        return { ok: true, status: 200, json: async () => ({ path: '/user/files/twitterlike-feed.json' }) };
    });

    saveFeedDebounced({ posts: [{ id: 'p1', body: 'stale' }], interactions: [] }, 0);
    await new Promise(resolve => setTimeout(resolve, 5));
    const latest = writeFeed({ posts: [{ id: 'p2', body: 'latest' }], interactions: [] });
    release();
    await latest;
    await flushFeed();

    assert.equal(uploads.length, 3);
    assert.match(uploads[0], /stale/);
    assert.match(uploads[1], /stale/);
    assert.match(uploads[2], /latest/);
});

test('concurrent direct saves each wait for their own upload', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const uploads = [];
    fakeFetch(async (_url, init) => {
        uploads.push(decodeUpload(init));
        if (uploads.length === 1) {
            await gate;
        }
        return { ok: true, status: 200, json: async () => ({ path: `/user/files/twitterlike-feed-save-${uploads.length}.json` }) };
    });

    const first = writeFeed({ posts: [{ id: 'p1', body: 'first' }], interactions: [] });
    await new Promise(resolve => setTimeout(resolve, 5));
    const second = writeFeed({ posts: [{ id: 'p2', body: 'second' }], interactions: [] });
    assert.equal(uploads.length, 1);
    release();

    assert.equal(await first, '/user/files/twitterlike-feed-save-1.json');
    assert.equal(await second, '/user/files/twitterlike-feed-save-2.json');
    assert.equal(uploads.length, 2);
    assert.match(uploads[0], /first/);
    assert.match(uploads[1], /second/);
});

test('an aborted transaction waiting in the save queue is never uploaded', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    fakeFetch(async () => {
        await gate;
        return { ok: true, status: 200, json: async () => ({ path: '/user/files/twitterlike-feed.json' }) };
    });
    saveFeedDebounced({ posts: [{ id: 'p1', body: 'visible' }], interactions: [] }, 0);
    await new Promise(resolve => setTimeout(resolve, 5));

    const controller = new AbortController();
    const transaction = writeFeed(
        { posts: [{ id: 'p2', body: 'cancelled' }], interactions: [] },
        ensureActiveSession().id,
        { signal: controller.signal },
    );
    controller.abort();
    release();

    await assert.rejects(() => transaction, error => error?.name === 'AbortError');
    assert.equal(fetchCalls.length, 1);
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

test('unsaved timelines receive independent empty feed arrays', async () => {
    const first = await loadFeed();
    first.posts.push({ id: 'local-only' });
    const second = await loadFeed();
    assert.deepEqual(second.posts, []);
});

test('a corrupt feed file fails closed instead of becoming a writable empty feed', async () => {
    updateSettings({ shards: ['/user/files/twitterlike-feed.json'] });
    // What a proxy or a signed-out session hands back instead of the file.
    fakeFetch(() => ({ ok: true, status: 200, text: async () => '<!DOCTYPE html><title>SillyBunny</title>' }));
    await assert.rejects(() => loadFeed(), /is not a timeline - it starts with "<!DOCTYPE html>/);
    assert.equal(fetchCalls.filter(([url]) => url === '/api/files/upload').length, 0);
});

test('a feed file left base64 encoded by the host is still read back', async () => {
    updateSettings({ shards: ['/user/files/twitterlike-feed.json'] });
    // Some hosts write the upload payload verbatim instead of decoding it.
    const stored = { posts: [{ id: 'p1', authorKey: 'a', body: 'héllo ✨', createdAt: 1 }], interactions: [] };
    const encoded = Buffer.from(JSON.stringify(stored), 'utf8').toString('base64');
    fakeFetch(() => ({ ok: true, status: 200, text: async () => `${encoded}\n` }));
    const feed = await loadFeed();
    assert.equal(feed.posts[0].body, 'héllo ✨');
});

test('the decoded limit permits base64 whose encoding exceeds 20 MB', async () => {
    updateSettings({ shards: ['/user/files/twitterlike-feed.json'] });
    const encoded = Buffer.from(JSON.stringify({
        version: 1,
        posts: [],
        interactions: [],
        padding: 'x'.repeat(15 * 1024 * 1024),
    })).toString('base64');
    assert.ok(encoded.length > 20 * 1024 * 1024);
    fakeFetch(() => ({ ok: true, status: 200, text: async () => encoded }));
    assert.deepEqual(await loadFeed(), { version: 1, posts: [], interactions: [] });
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

test('a successful overwrite without a returned path retains the trusted pointer', async () => {
    const session = ensureActiveSession();
    updateSession(session.id, { feedPath: '/user/files/twitterlike-feed-old.json' });
    fakeFetch(() => ({ ok: true, status: 200, json: async () => ({}) }));
    assert.equal(await writeFeed({ posts: [], interactions: [] }), '/user/files/twitterlike-feed-old.json');
    assert.equal(getSession(session.id).feedPath, '/user/files/twitterlike-feed-old.json');
});

test('a first upload without a valid path rejects', async () => {
    fakeFetch(() => ({ ok: true, status: 200, json: async () => ({}) }));
    await assert.rejects(() => writeFeed({ posts: [], interactions: [] }), /valid Hopper timeline path/);
});

test('a committed first upload survives an immediate settings flush failure', async () => {
    current.saveSettings = async () => { throw new Error('settings disk full'); };
    const session = ensureActiveSession();
    const path = await writeFeed({ posts: [], interactions: [] }, session.id);
    assert.equal(path, '/user/files/twitterlike-feed.json');
    assert.equal(getSession(session.id).feedPath, path);
});

test('writeFeed refuses a feed that loadFeed could not read back', async () => {
    const body = 'x'.repeat(20 * 1024 * 1024 + 1);
    await assert.rejects(
        () => writeFeed({ posts: [{ id: 'p1', body }], interactions: [] }),
        /too large to save safely/,
    );
    assert.equal(fetchCalls.length, 0);
});

test('image uploads use the declared raster type, verify its signature and require a path', async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00]);
    const file = { name: 'spoofed.svg', type: 'image/png', size: png.length, arrayBuffer: async () => png.buffer };
    fakeFetch((_url, init) => {
        assert.match(JSON.parse(init.body).name, /\.png$/);
        return { ok: true, status: 200, json: async () => ({ path: '/user/files/picture.png' }) };
    });
    assert.equal(await uploadImage(file), '/user/files/picture.png');

    const svg = new TextEncoder().encode('<svg>');
    await assert.rejects(() => uploadImage({ ...file, arrayBuffer: async () => svg.buffer }), /does not match/);
    fakeFetch(() => ({ ok: true, status: 200, json: async () => ({}) }));
    await assert.rejects(() => uploadImage(file), /valid path/);
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

test('stored feed fields and timestamps are bounded before rendering or prompting', async () => {
    updateSettings({ shards: ['/user/files/twitterlike-feed.json'] });
    fakeFetch(() => ({ ok: true, status: 200, json: async () => ({
        version: 1,
        posts: [{ id: 'p1', authorKey: 'a', body: 'x'.repeat(10_000), createdAt: 1e300 }],
        interactions: [{ id: 'r1', postId: 'p1', type: 'reply', actorKey: 'b', content: 'y'.repeat(5_000), createdAt: -1e300 }],
    }) }));
    const feed = await loadFeed();
    assert.equal(feed.posts[0].body.length, 4000);
    assert.equal(feed.interactions[0].content.length, 2000);
    assert.equal(feed.posts[0].createdAt, 0);
    assert.equal(feed.interactions[0].createdAt, 0);
});

test('a newer feed format is refused instead of silently downgraded', async () => {
    updateSettings({ shards: ['/user/files/twitterlike-feed.json'] });
    fakeFetch(() => ({ ok: true, status: 200, json: async () => ({ version: 2, posts: [], interactions: [] }) }));
    await assert.rejects(() => loadFeed(), /newer timeline format/);
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

test('a reply to a specific reply keeps its parent through save and load', async () => {
    const stored = {
        version: 1,
        posts: [{ id: 'p1', authorKey: 'character:ada.png', body: 'root', createdAt: 1 }],
        interactions: [
            { id: 'r1', postId: 'p1', type: 'reply', actorKey: 'character:bo.png', content: 'first', createdAt: 2, parentInteractionId: null },
            { id: 'r2', postId: 'p1', type: 'reply', actorKey: 'persona:me.png', content: 'answering Bo', createdAt: 3, parentInteractionId: 'r1' },
        ],
    };
    updateSettings({ shards: ['/user/files/twitterlike-feed.json'] });
    fakeFetch(() => ({ ok: true, status: 200, json: async () => stored }));
    const feed = await loadFeed();
    assert.equal(feed.interactions[1].parentInteractionId, 'r1');
    assert.equal(feed.interactions[1].postId, 'p1');

    feed.interactions.push({
        id: 'r3', postId: 'p1', type: 'reply', actorKey: 'persona:me.png',
        content: 'thread continues', parentInteractionId: 'r2', pollOptionIndex: null, createdAt: 4,
    });
    fakeFetch(() => ({ ok: true, status: 200, json: async () => ({ path: '/user/files/twitterlike-feed.json' }) }));
    await writeFeed(feed);
    const saved = JSON.parse(decodeUpload(fetchCalls.find(([url]) => url === '/api/files/upload')[1]));
    assert.equal(saved.interactions.find(item => item.id === 'r3').parentInteractionId, 'r2');
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
    const session = ensureActiveSession();
    updateSession(session.id, { invited: [], ambient: false });
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
    assert.ok(getSession(ensureActiveSession().id).lastRefreshAt > 0);
});

test('made-up trends from a refresh replace the session trends', async () => {
    updateSettings({ profiles: { 'character:ada.png': { handle: 'ada' }, 'character:bo.png': { handle: 'bo' } } });
    current.nextResponse = JSON.stringify({ posts: [], interactions: [], follows: [], trends: [{ topic: '#TideWatch', posts: 1200 }, { topic: 'harbour market', posts: 80 }] });
    await runRefresh({ feed: emptyFeed() });
    assert.deepEqual(getSession(ensureActiveSession().id).trends.map(t => t.topic), ['#TideWatch', 'harbour market']);
    current.nextResponse = JSON.stringify({ posts: [], interactions: [], follows: [], trends: [{ topic: '#Fog', posts: 3 }] });
    await runRefresh({ feed: emptyFeed() });
    assert.deepEqual(getSession(ensureActiveSession().id).trends.map(t => t.topic), ['#Fog']);
    current.nextResponse = GOOD_BATCH;
    await runRefresh({ feed: emptyFeed() });
    assert.deepEqual(getSession(ensureActiveSession().id).trends.map(t => t.topic), ['#Fog'], 'a refresh without trends keeps the last set');
});

test('one post at a time: one request per post, each committed and shown as it lands', async () => {
    updateSettings({ incremental: true, concurrency: 1, quotas: { posts: 3, replies: 6, reposts: 2, likes: 9 }, profiles: { 'character:ada.png': { handle: 'ada' }, 'character:bo.png': { handle: 'bo' } } });
    const feed = emptyFeed();
    const seen = [];
    const turns = [];
    current.generateRaw = async ({ prompt }) => {
        const match = /as @(\w+) only/.exec(prompt);
        const author = match ? match[1] : 'ada';
        turns.push({ author, quotaLine: (/posts: at most (\d+)/.exec(prompt) || [])[1], turnLine: (/Post (\d) of (\d)/.exec(prompt) || []).slice(1, 3).join('/') });
        return JSON.stringify({
            posts: [{ tempId: 't', authorHandle: author, content: `post by ${author} #${turns.length}` }, { tempId: 'extra', authorHandle: author, content: 'a second post that must be dropped' }],
            interactions: [{ actorHandle: author === 'ada' ? 'bo' : 'ada', type: 'reply', targetTempId: 't', content: `reply ${turns.length}` }],
            follows: [],
        });
    };
    const result = await runRefresh({ feed, onPartial: () => seen.push(feed.posts.length) });
    assert.equal(turns.length, 3, 'one request per post');
    assert.equal(turns[0].author, turns[2].author, 'authors wrap after rotating');
    assert.notEqual(turns[0].author, turns[1].author, 'authors rotate');
    assert.deepEqual(new Set(turns.map(t => t.author)), new Set(['ada', 'bo']));
    assert.deepEqual(turns.map(t => t.quotaLine), ['1', '1', '1'], 'each turn is told one post');
    assert.deepEqual(turns.map(t => t.turnLine), ['1/3', '2/3', '3/3']);
    assert.deepEqual(seen, [1, 2, 3], 'the feed is shown after every committed post');
    assert.equal(result.posts.length, 3);
    assert.equal(result.interactions.length, 3);
    assert.equal(feed.posts.length, 3);
    assert.ok(getSession(ensureActiveSession().id).lastRefreshAt > 0);

    // a malformed turn is skipped, not fatal
    let calls = 0;
    current.generateRaw = async ({ prompt }) => {
        calls += 1;
        const author = (/as @(\w+) only/.exec(prompt) || [])[1];
        return calls <= 2 ? 'not json' : JSON.stringify({ posts: [{ authorHandle: author, content: `late ${calls}` }], interactions: [], follows: [] });
    };
    const feed2 = emptyFeed();
    const result2 = await runRefresh({ feed: feed2 });
    assert.ok(result2.warnings.some(w => /skipped/.test(w)));
    assert.ok(feed2.posts.length >= 1);
    updateSettings({ incremental: false, concurrency: 3 });
});

test('incremental mode honours a zero post quota through the batch path', async () => {
    updateSettings({
        incremental: true,
        concurrency: 3,
        quotas: { posts: 0, replies: 2, reposts: 1, likes: 2 },
        profiles: { 'character:ada.png': { handle: 'ada' }, 'character:bo.png': { handle: 'bo' } },
    });
    current.nextResponse = JSON.stringify({ posts: [{ authorHandle: 'ada', content: 'must not land' }], interactions: [], follows: [] });
    const result = await runRefresh({ feed: emptyFeed() });
    assert.equal(result.posts.length, 0);
    assert.equal(current.calls.filter(call => call[0] === 'generateRaw').length, 1);
});

test('sequential rolling mode shares poll and image budgets across every turn', async () => {
    updateSettings({
        incremental: true,
        concurrency: 1,
        quotas: { posts: 3, replies: 0, reposts: 0, likes: 0 },
        images: { enabled: true, perRefresh: 1 },
        profiles: { 'character:ada.png': { handle: 'ada' }, 'character:bo.png': { handle: 'bo' } },
    });
    current.nextImage = '/user/images/one.png';
    let turn = 0;
    current.generateRaw = async ({ prompt }) => {
        turn += 1;
        const author = (/as @(\w+) only/.exec(prompt) ?? [])[1] ?? 'ada';
        return JSON.stringify({
            posts: [{ authorHandle: author, content: `turn ${turn}`, imagePrompt: `image ${turn}`, poll: { question: `q${turn}`, options: ['a', 'b'] } }],
            interactions: [], follows: [],
        });
    };
    const result = await runRefresh({ feed: emptyFeed() });
    assert.equal(result.posts.length, 3);
    assert.equal(result.posts.filter(post => post.poll).length, 1);
    assert.equal(result.posts.filter(post => post.image).length, 1);
    assert.equal(current.calls.filter(call => call[0] === 'slash').length, 1);
});

test('several at once: the requests overlap, the caps still hold, and only the first turn opens the door', async () => {
    updateSettings({ incremental: true, concurrency: 3, quotas: { posts: 3, replies: 6, reposts: 2, likes: 9 }, profiles: { 'character:ada.png': { handle: 'ada' }, 'character:bo.png': { handle: 'bo' } } });
    updateSession(ensureActiveSession().id, { ambient: true });
    const feed = emptyFeed();
    const seen = [];
    const prompts = [];
    let inFlight = 0;
    let mostAtOnce = 0;
    current.generateRaw = async ({ prompt }) => {
        inFlight += 1;
        mostAtOnce = Math.max(mostAtOnce, inFlight);
        await new Promise(resolve => setTimeout(resolve, 5));
        const author = (/as @(\w+) only/.exec(prompt) ?? [])[1] ?? 'ada';
        prompts.push(prompt);
        inFlight -= 1;
        return JSON.stringify({
            posts: [{ tempId: 't', authorHandle: author, content: `post by ${author} #${prompts.length}` }],
            interactions: [{ actorHandle: author === 'ada' ? 'bo' : 'ada', type: 'reply', targetTempId: 't', content: `reply ${prompts.length}` }],
            follows: [],
        });
    };
    const result = await runRefresh({ feed, onPartial: () => seen.push(feed.posts.length) });

    assert.equal(prompts.length, 3, 'one request per post');
    assert.equal(mostAtOnce, 3, 'and all three were in flight together');
    assert.deepEqual(seen, [1, 2, 3], 'each lands on its own, in order, however they finished');
    assert.equal(result.posts.length, 3);
    assert.equal(feed.posts.length, 3);

    // The allowance is split up front, so turns that cannot see each other still add up to the caps.
    const replyCaps = prompts.map(prompt => Number((/replies: at most (\d+)/.exec(prompt) ?? [])[1]));
    assert.deepEqual(replyCaps, [2, 2, 2], 'six replies across three turns');
    assert.equal(replyCaps.reduce((sum, value) => sum + value, 0), 6);
    const likeCaps = prompts.map(prompt => Number((/likes: at most (\d+)/.exec(prompt) ?? [])[1]));
    assert.equal(likeCaps.reduce((sum, value) => sum + value, 0), 9);

    // Strangers, a poll and the trending bar belong to the opening turn; the rest would multiply them.
    const opener = prompts.find(prompt => /Post 1 of 3/.test(prompt));
    const others = prompts.filter(prompt => !/Post 1 of 3/.test(prompt));
    assert.match(opener, /You may introduce up to 2 new strangers/);
    assert.match(opener, /polls: at most 1/);
    assert.match(opener, /Also return 4 to 6 "trends"/);
    for (const prompt of others) {
        assert.match(prompt, /Not allowed this refresh: leave "strangers" empty/);
        assert.match(prompt, /polls: at most 0/);
        assert.match(prompt, /Leave "trends" empty/);
    }

    updateSession(ensureActiveSession().id, { ambient: false });
    updateSettings({ incremental: false });
});

test('parallel turns commit in landing order and revalidate duplicate reactions against current state', async () => {
    updateSettings({
        incremental: true,
        concurrency: 3,
        quotas: { posts: 3, replies: 0, reposts: 0, likes: 3 },
        profiles: { 'character:ada.png': { handle: 'ada' }, 'character:bo.png': { handle: 'bo' } },
    });
    const feed = {
        version: 1,
        posts: [{ id: 'p0', authorKey: 'persona:me.png', body: 'existing', createdAt: Date.now() }],
        interactions: [],
    };
    current.generateRaw = async ({ prompt }) => {
        const index = Number((/Post (\d) of 3/.exec(prompt) ?? [])[1]);
        const author = (/as @(\w+) only/.exec(prompt) ?? [])[1];
        await new Promise(resolve => setTimeout(resolve, { 1: 30, 2: 5, 3: 15 }[index]));
        return JSON.stringify({
            posts: [{ authorHandle: author, content: `turn ${index}` }],
            interactions: [{ actorHandle: 'bo', type: 'like', targetPostId: 'p0' }],
            follows: [],
        });
    };
    const landed = [];
    const result = await runRefresh({ feed, onPartial: partial => landed.push(partial.posts[0]?.body) });
    assert.deepEqual(landed, ['turn 2', 'turn 3', 'turn 1']);
    assert.equal(result.interactions.filter(item => item.type === 'like').length, 1);
});

test('parallel refresh propagates a total provider outage and does not stamp success', async () => {
    const session = ensureActiveSession();
    updateSettings({
        incremental: true,
        concurrency: 2,
        quotas: { posts: 2, replies: 0, reposts: 0, likes: 0 },
        profiles: { 'character:ada.png': { handle: 'ada' }, 'character:bo.png': { handle: 'bo' } },
    });
    current.generateRaw = async () => { throw new Error('provider 401'); };
    await assert.rejects(() => runRefresh({ feed: emptyFeed() }), /provider 401/);
    assert.equal(getSession(session.id).lastRefreshAt, 0);
});

test('regenerateAllProfiles rewrites every invited character in one request, ruling out every current handle', async () => {
    ensureActiveSession();
    current.nextResponse = JSON.stringify({ profiles: [
        { entityId: 'ada.png', name: 'Ada', handle: 'proof_by_tea', bio: 'qed', location: 'the board' },
        { entityId: 'bo.png', name: 'Bo', handle: 'late_again', bio: 'on my way', location: 'the van' },
    ] });
    const written = await regenerateAllProfiles();
    assert.equal(written, 2);
    assert.equal(getSettings().profiles['character:ada.png'].handle, 'proof_by_tea');
    assert.equal(getSettings().profiles['character:bo.png'].handle, 'late_again');
    const requests = current.calls.filter(([name]) => name === 'generateRaw');
    assert.equal(requests.length, 1, 'one request for everyone');
    const taken = (requests[0][1].prompt.match(/# Handles Already Taken\n[^\n]*/) ?? [''])[0];
    for (const handle of ['@me', '@ada', '@bo']) {
        assert.ok(taken.includes(handle), `${handle} is ruled out`);
    }
});

test('clearing the strangers forgets them without touching what they already posted', () => {
    const session = ensureActiveSession();
    updateSession(session.id, { strangers: [
        { id: 'stranger-pip', name: 'Pip', handle: 'pip_pip', bio: 'Just here for the polls.', createdAt: 1 },
        { id: 'stranger-jo', name: 'Ferry Jo', handle: 'ferry_jo', bio: 'Commutes by boat.', createdAt: 2 },
    ] });
    assert.equal(clearStrangers(session.id), 2);
    assert.deepEqual(getSession(session.id).strangers, []);
    assert.equal(clearStrangers(session.id), 0, 'clearing again is a no-op');
    assert.throws(() => clearStrangers('nope'), /no longer exists/);
});

test('generatePersonaProfile writes the persona profile from the persona description', async () => {
    const session = ensureActiveSession();
    const accounts = await currentAccounts(session.id);
    const persona = accounts.find(account => account.kind === 'persona');
    assert.ok(persona, 'the test context has a persona');
    current.nextResponse = JSON.stringify({ profiles: [{ entityId: persona.entityId, name: 'Wren of the Harbour', handle: 'wren_harbour', bio: 'Runs the noticeboard.', location: 'Harbour end' }] });
    const profile = await generatePersonaProfile(session.id);
    assert.deepEqual(profile, { name: 'Wren of the Harbour', handle: 'wren_harbour', bio: 'Runs the noticeboard.', location: 'Harbour end' });
    const sent = current.calls.filter(call => call[0] === 'generateRaw').at(-1);
    assert.ok(String(sent?.[1]?.prompt ?? sent?.[1]?.systemPrompt ?? JSON.stringify(sent)).includes(persona.entityId), 'the persona is the profile target');
    current.nextResponse = 'not json';
    assert.equal(await generatePersonaProfile(session.id), null);
});

test('a topic refresh sends the topic and leaves the trending bar alone', async () => {
    const session = ensureActiveSession();
    updateSession(session.id, { trends: [{ topic: '#Old', posts: 2 }] });
    current.nextResponse = JSON.stringify({
        posts: [{ authorHandle: 'ada', content: 'off topic' }], interactions: [], follows: [],
        trends: [{ topic: '#Injected', posts: 3 }],
    });
    const result = await runRefresh({ feed: emptyFeed(), topic: '#TideWatch' });
    const sent = JSON.stringify(current.calls.filter(call => call[0] === 'generateRaw').at(-1)[1]);
    assert.match(sent, /# Topic/);
    assert.match(sent, /#TideWatch/);
    assert.match(sent, /Leave \\"trends\\" empty/);
    assert.equal(result.posts.length, 0);
    assert.deepEqual(getSession(session.id).trends.map(trend => trend.topic), ['#Old']);
});

test('a rolling turn cannot substitute another active post author', async () => {
    updateSettings({
        incremental: true,
        concurrency: 1,
        quotas: { posts: 1, replies: 0, reposts: 0, likes: 0 },
        profiles: { 'character:ada.png': { handle: 'ada' }, 'character:bo.png': { handle: 'bo' } },
    });
    current.generateRaw = async ({ prompt }) => {
        const assigned = (/as @(\w+) only/.exec(prompt) || [])[1];
        const wrong = assigned === 'ada' ? 'bo' : 'ada';
        return JSON.stringify({ posts: [{ authorHandle: wrong, content: 'wrong turn' }], interactions: [], follows: [] });
    };
    const result = await runRefresh({ feed: emptyFeed() });
    assert.equal(result.posts.length, 0);
    assert.ok(result.warnings.some(warning => /not allowed to post/.test(warning)));
});

test('a refresh commits only to the session it started with', async () => {
    const first = ensureActiveSession();
    const second = createSession({ personaId: 'me.png', invited: ['bo.png'] });
    current.nextResponse = GOOD_BATCH;
    updateSettings({ profiles: { 'character:ada.png': { handle: 'ada' }, 'character:bo.png': { handle: 'bo' } } });
    await runRefresh({ sessionId: first.id, feed: emptyFeed() });
    assert.ok(getSession(first.id).lastRefreshAt > 0);
    assert.equal(getSession(second.id).lastRefreshAt, 0);
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

test('a removed connection profile fails closed instead of switching providers', async () => {
    current.ConnectionManagerRequestService = {
        getSupportedProfiles: () => [],
        async sendRequest() { throw new Error('must not be called'); },
    };
    updateSettings({
        profileId: 'deleted',
        profiles: { 'character:ada.png': { handle: 'ada' }, 'character:bo.png': { handle: 'bo' } },
    });
    await assert.rejects(() => runRefresh({ feed: emptyFeed() }), /selected connection profile is unavailable/i);
    assert.equal(getSettings().profileId, 'deleted');
    assert.equal(current.calls.filter(call => call[0] === 'generateRaw').length, 0);
});

test('profile discovery failure does not reroute generation or clear the selection', async () => {
    current.ConnectionManagerRequestService = {
        getSupportedProfiles() { throw new Error('temporarily unavailable'); },
        async sendRequest() { throw new Error('must not be called'); },
    };
    updateSettings({
        profileId: 'p1',
        profiles: { 'character:ada.png': { handle: 'ada' }, 'character:bo.png': { handle: 'bo' } },
    });
    await assert.rejects(() => runRefresh({ feed: emptyFeed() }), /profiles could not be read/);
    assert.equal(getSettings().profileId, 'p1');
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
    assert.deepEqual(getSession(ensureActiveSession().id).follows['character:ada.png'], ['character:bo.png']);
});

test('a failed save leaves the timeline and lastRefreshAt untouched', async () => {
    current.nextResponse = GOOD_BATCH;
    updateSettings({ profiles: { 'character:ada.png': { handle: 'ada' }, 'character:bo.png': { handle: 'bo' } } });
    fakeFetch(() => ({ ok: false, status: 500, json: async () => ({}) }));
    const feed = emptyFeed();
    await assert.rejects(() => runRefresh({ feed }), /Could not save/);
    assert.equal(feed.posts.length, 0);
    assert.equal(feed.interactions.length, 0);
    assert.ok(!(getSession(ensureActiveSession().id).lastRefreshAt > 0));
});

test('a refresh commits in memory once its upload is durable', async () => {
    const controller = new AbortController();
    current.nextResponse = GOOD_BATCH;
    updateSettings({ profiles: { 'character:ada.png': { handle: 'ada' }, 'character:bo.png': { handle: 'bo' } } });
    fakeFetch(() => {
        controller.abort();
        return { ok: true, status: 200, json: async () => ({ path: '/user/files/twitterlike-feed.json' }) };
    });
    const feed = emptyFeed();

    await runRefresh({ feed, signal: controller.signal });

    assert.equal(feed.posts.length, 1);
    assert.ok(getSession(ensureActiveSession().id).lastRefreshAt > 0);
});

test('a throwing partial observer cannot turn a durable refresh into a failure', async () => {
    current.nextResponse = GOOD_BATCH;
    updateSettings({ profiles: { 'character:ada.png': { handle: 'ada' }, 'character:bo.png': { handle: 'bo' } } });
    const feed = emptyFeed();
    const result = await runRefresh({ feed, onPartial: () => { throw new Error('render failed'); } });
    assert.equal(result.posts.length, 1);
    assert.equal(feed.posts.length, 1);
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
    const session = ensureActiveSession();
    updateSession(session.id, { follows: { 'character:bo.png': ['persona:me.png'] } });
    release();
    await refresh;

    const follows = getSession(session.id).follows;
    assert.deepEqual(follows['character:ada.png'], ['character:bo.png']);
    assert.deepEqual(follows['character:bo.png'], ['persona:me.png']);
});

test('a model image prompt cannot inject /imagine flags', async () => {
    current.nextResponse = JSON.stringify({
        posts: [{ authorHandle: 'ada', content: 'look', imagePrompt: 'quiet=false gallery=true "evil" {{lastMessage}}' }],
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
    assert.doesNotMatch(command, /\{\{lastMessage/);
    assert.match(command, /\\"evil\\"/);
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

test('a stale carryover build cannot replace the current prompt', async () => {
    updateSettings({ carry: { enabled: true, hours: 48, items: 8, depth: 1 } });
    const session = ensureActiveSession();
    await currentAccounts(session.id);
    const feed = {
        posts: [{
            id: 'p1',
            authorKey: 'character:ada.png',
            body: 'old session text',
            createdAt: Date.now(),
            authorSnapshot: { name: 'Ada' },
        }],
        interactions: [],
    };
    await applyCarryover(feed, session.id, { isCurrent: () => false });
    assert.equal(current.calls.filter(call => call[0] === 'setExtensionPrompt').length, 0);
});
