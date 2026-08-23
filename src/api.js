// Every call into the SillyBunny host lives here. Nothing in this file touches the DOM.

import {
    EXT_PROMPT_KEY,
    KIND_AMBIENT,
    KIND_CHARACTER,
    KIND_PERSONA,
    SETTINGS_KEY,
    buildCarryoverBlock,
    buildCorrectionMessage,
    buildProfileMessages,
    buildRefreshMessages,
    deriveAccounts,
    digestLines,
    materializeRefresh,
    normalizeSettings,
    parseProfileResponse,
    parseRefreshResponse,
    selectParticipants,
    MAX_NEW_STRANGERS_PER_REFRESH,
} from './core.js';

// getContext() copies chatId / characterId / chatMetadata by value, so a cached reference
// silently reads the wrong chat. Always resolve it fresh.
function ctx() {
    return globalThis.SillyTavern.getContext();
}

// Host magic numbers, named locally rather than deep-imported.
const EXTENSION_PROMPT_TYPE_IN_CHAT = 1;
const EXTENSION_PROMPT_ROLE_SYSTEM = 0;

const FEED_FILE = 'twitterlike-feed.json';
const REFRESH_MAX_TOKENS = 4096;
/** One post plus its reactions never needs a whole batch's worth of output. */
const TURN_MAX_TOKENS = 1536;
const PROFILE_MAX_TOKENS_BASE = 1024;

// --- settings -------------------------------------------------------------

export function getSettings() {
    const context = ctx();
    const normalized = normalizeSettings(context.extensionSettings?.[SETTINGS_KEY]);
    if (context.extensionSettings) {
        context.extensionSettings[SETTINGS_KEY] = normalized;
    }
    return normalized;
}

export function updateSettings(patch) {
    const context = ctx();
    const next = normalizeSettings({ ...getSettings(), ...patch });
    if (context.extensionSettings) {
        context.extensionSettings[SETTINGS_KEY] = next;
    }
    context.saveSettingsDebounced?.();
    return next;
}

export function listSessions() {
    return Object.values(getSettings().sessions);
}

export function getSession(sessionId) {
    return getSettings().sessions[sessionId] ?? null;
}

export function updateSession(sessionId, patch) {
    const settings = getSettings();
    const current = settings.sessions[sessionId];
    if (!current) {
        throw new Error('That timeline session no longer exists.');
    }
    const sessions = { ...settings.sessions, [sessionId]: { ...current, ...patch, id: sessionId } };
    const next = updateSettings({ sessions });
    const session = next.sessions[sessionId];
    if (next.activeSessionId === sessionId && session.personaId) {
        return updateSettings({
            activeSessionByPersona: { ...next.activeSessionByPersona, [session.personaId]: sessionId },
        }).sessions[sessionId];
    }
    return session;
}

export function ensureActiveSession(personaId = ctx().userAvatar ?? '') {
    const settings = getSettings();
    const sessions = settings.sessions;
    let session = sessions[settings.activeSessionByPersona[personaId]];
    if (!session && settings.activeSessionId) {
        const active = sessions[settings.activeSessionId];
        session = active?.personaId === personaId ? active : null;
    }
    session ??= Object.values(sessions).find(item => item.personaId === personaId);
    if (!session) {
        const unowned = Object.values(sessions).find(item => !item.personaId);
        if (unowned) {
            session = updateSession(unowned.id, {
                personaId,
                personaProfile: settings.profiles[`${KIND_PERSONA}:${personaId}`] ?? unowned.personaProfile,
            });
        }
    }
    if (!session) {
        session = createSession({ personaId });
    }
    const fresh = getSettings();
    if (fresh.activeSessionId !== session.id || fresh.activeSessionByPersona[personaId] !== session.id) {
        updateSettings({
            activeSessionId: session.id,
            activeSessionByPersona: { ...fresh.activeSessionByPersona, [personaId]: session.id },
        });
    }
    return getSession(session.id);
}

export function createSession({ name = '', type = '', personaId = '', invited = [], ambient = false } = {}) {
    const context = ctx();
    const settings = getSettings();
    let id = String(context.uuidv4?.() ?? `${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || `${Date.now()}`;
    while (settings.sessions[id]) {
        id = `${id}x`;
    }
    const session = {
        id,
        name: name || `Timeline ${Object.keys(settings.sessions).length + 1}`,
        type: type || 'Open timeline',
        personaId: personaId || context.userAvatar || '',
        invited,
        ambient,
        scenarioNoteIds: [],
        personaProfile: {},
        follows: {},
        lastRefreshAt: 0,
        feedPath: '',
    };
    const next = updateSettings({
        sessions: { ...settings.sessions, [id]: session },
        activeSessionId: id,
        activeSessionByPersona: session.personaId
            ? { ...settings.activeSessionByPersona, [session.personaId]: id }
            : settings.activeSessionByPersona,
    });
    return next.sessions[id];
}

export async function selectSession(sessionId, { personaId = null } = {}) {
    const before = getSettings();
    const session = before.sessions[sessionId];
    if (!session) {
        throw new Error('That timeline session no longer exists.');
    }
    const targetPersonaId = personaId ?? session.personaId;
    if (targetPersonaId && !listPersonas().some(persona => persona.entityId === targetPersonaId)) {
        throw new Error('That persona is no longer available.');
    }
    const changedPersona = targetPersonaId !== session.personaId;
    const sessions = changedPersona
        ? {
            ...before.sessions,
            [sessionId]: {
                ...session,
                personaId: targetPersonaId,
                scenarioNoteIds: [],
                personaProfile: {},
            },
        }
        : before.sessions;
    const activeSessionByPersona = Object.fromEntries(
        Object.entries(before.activeSessionByPersona).filter(([, id]) => id !== sessionId),
    );
    if (targetPersonaId) {
        activeSessionByPersona[targetPersonaId] = sessionId;
    }
    updateSettings({
        sessions,
        activeSessionId: sessionId,
        activeSessionByPersona,
    });
    if (targetPersonaId && targetPersonaId !== ctx().userAvatar) {
        try {
            const { setUserAvatar } = await import('/scripts/personas.js');
            await setUserAvatar(targetPersonaId, { toastPersonaNameChange: false });
        } catch (error) {
            if (ctx().userAvatar !== targetPersonaId) {
                const fresh = getSettings();
                const freshSession = fresh.sessions[sessionId];
                const rolledBackSession = changedPersona && freshSession?.personaId === targetPersonaId
                    ? {
                        ...freshSession,
                        personaId: session.personaId,
                        scenarioNoteIds: session.scenarioNoteIds,
                        personaProfile: session.personaProfile,
                    }
                    : freshSession;
                const rolledBackByPersona = { ...fresh.activeSessionByPersona };
                if (targetPersonaId && rolledBackByPersona[targetPersonaId] === sessionId) {
                    if (before.activeSessionByPersona[targetPersonaId]) {
                        rolledBackByPersona[targetPersonaId] = before.activeSessionByPersona[targetPersonaId];
                    } else {
                        delete rolledBackByPersona[targetPersonaId];
                    }
                }
                if (session.personaId && before.activeSessionByPersona[session.personaId]) {
                    rolledBackByPersona[session.personaId] = before.activeSessionByPersona[session.personaId];
                }
                updateSettings({
                    sessions: rolledBackSession
                        ? { ...fresh.sessions, [sessionId]: rolledBackSession }
                        : fresh.sessions,
                    activeSessionId: fresh.activeSessionId === sessionId ? before.activeSessionId : fresh.activeSessionId,
                    activeSessionByPersona: rolledBackByPersona,
                });
                throw new Error(`The host could not switch to that persona (${error.message}).`);
            }
            console.warn('[Hopper] the host switched persona but a listener reported an error', error);
        }
    }
    return getSession(sessionId);
}

// --- characters and personas ---------------------------------------------

/**
 * context.characters is [] until getCharacters() has been awaited - and [] passes a
 * truthiness check, so an unrefreshed read looks exactly like "no characters installed".
 */
export async function ensureCharacters() {
    const context = ctx();
    if (!Array.isArray(context.characters) || context.characters.length === 0) {
        await context.getCharacters();
    }
    return ctx().characters ?? [];
}

export function listPersonas() {
    const context = ctx();
    const personas = context.powerUserSettings?.personas ?? {};
    const list = Object.entries(personas).map(([entityId, name]) => ({ entityId, name: String(name || 'You') }));
    if (context.userAvatar && !list.some(persona => persona.entityId === context.userAvatar)) {
        list.push({ entityId: context.userAvatar, name: context.name1 || 'You' });
    }
    return list;
}

export function getScenarioNotes(personaId) {
    const appendices = ctx().powerUserSettings?.persona_descriptions?.[personaId]?.appendices;
    if (!Array.isArray(appendices)) {
        return [];
    }
    return appendices.map((note, index) => ({
        id: String(note?.id || `scenario-note-${index}`),
        name: String(note?.name || `Scenario Note ${index + 1}`),
        description: String(note?.description ?? ''),
    })).filter(note => note.id);
}

export function getPersona(personaId = ctx().userAvatar, scenarioNoteIds = []) {
    const context = ctx();
    const entityId = personaId;
    if (!entityId) {
        return null;
    }
    const descriptor = context.powerUserSettings?.persona_descriptions?.[entityId] ?? {};
    const selected = new Set(scenarioNoteIds);
    const description = [String(descriptor.description ?? '').trim()];
    for (const note of getScenarioNotes(entityId)) {
        if (selected.has(note.id) && note.description.trim()) {
            description.push(`(${note.name})\n${note.description.trim()}`);
        }
    }
    return {
        entityId,
        name: context.powerUserSettings?.personas?.[entityId] || (entityId === context.userAvatar ? context.name1 : '') || 'You',
        description: description.filter(Boolean).join('\n\n'),
    };
}

export async function currentAccounts(sessionId = ensureActiveSession().id) {
    const settings = getSettings();
    const session = settings.sessions[sessionId];
    if (!session) {
        throw new Error('That timeline session no longer exists.');
    }
    const characters = await ensureCharacters();
    const persona = getPersona(session.personaId, session.scenarioNoteIds);
    const profiles = { ...settings.profiles };
    if (persona?.entityId) {
        profiles[`${KIND_PERSONA}:${persona.entityId}`] = session.personaProfile;
    }
    return deriveAccounts({
        characters,
        invited: session.invited,
        persona,
        ambient: session.ambient,
        strangers: session.strangers,
        profiles,
    });
}

export function avatarUrl(account) {
    const context = ctx();
    if (!account || account.kind === KIND_AMBIENT) {
        return '';
    }
    const type = account.kind === KIND_PERSONA ? 'persona' : 'avatar';
    const url = context.getThumbnailUrl(type, account.entityId);
    // A feed paints a lot of avatars at 44px; the mobile preset is the same image, smaller.
    return context.isMobile?.() ? `${url}&preset=mobile` : url;
}

// --- feed storage ---------------------------------------------------------

const emptyFeed = () => ({ version: 1, posts: [], interactions: [] });
const INTERACTION_TYPES = new Set(['like', 'repost', 'reply', 'vote']);

const isObj = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const storedText = value => (typeof value === 'string' ? value : '');
const storedTime = value => {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
};

function storedSnapshot(raw) {
    if (!isObj(raw)) {
        return null;
    }
    return {
        key: storedText(raw.key),
        kind: storedText(raw.kind),
        handle: storedText(raw.handle),
        name: storedText(raw.name),
    };
}

function storedPost(raw) {
    const id = storedText(raw?.id).trim();
    const authorKey = storedText(raw?.authorKey).trim();
    if (!id || !authorKey) {
        return null;
    }
    const pollRaw = isObj(raw.poll) ? raw.poll : null;
    const options = Array.isArray(pollRaw?.options)
        ? pollRaw.options
            .filter(option => option && typeof option.text === 'string' && option.text.trim())
            .slice(0, 4)
        : [];
    return {
        id,
        authorKey,
        body: storedText(raw.body),
        createdAt: storedTime(raw.createdAt),
        image: isObj(raw.image) && typeof raw.image.url === 'string'
            ? { url: raw.image.url, prompt: storedText(raw.image.prompt) }
            : null,
        poll: pollRaw && typeof pollRaw.question === 'string' && options.length >= 2
            ? {
                question: pollRaw.question,
                options: options.map((option, index) => ({
                    id: storedText(option.id) || `option-${index}`,
                    text: option.text,
                })),
            }
            : null,
        authorSnapshot: storedSnapshot(raw.authorSnapshot),
    };
}

function storedInteraction(raw, validPostIds) {
    const id = storedText(raw?.id).trim();
    const postId = storedText(raw?.postId).trim();
    const actorKey = storedText(raw?.actorKey).trim();
    const type = storedText(raw?.type);
    if (!id || !postId || !actorKey || !INTERACTION_TYPES.has(type)) {
        return null;
    }
    // An interaction pointing at a post nobody stored can never render or resolve.
    if (!validPostIds.has(postId)) {
        return null;
    }
    return {
        id,
        postId,
        type,
        actorKey,
        content: storedText(raw.content) || null,
        parentInteractionId: storedText(raw.parentInteractionId) || null,
        pollOptionIndex: Number.isInteger(raw?.pollOptionIndex) && raw.pollOptionIndex >= 0 ? raw.pollOptionIndex : null,
        createdAt: storedTime(raw.createdAt),
        actorSnapshot: storedSnapshot(raw.actorSnapshot),
    };
}

/**
 * Anything structurally usable becomes a well-formed feed; broken rows are dropped here
 * rather than crashing a render later. A file that cannot be read at all never reaches
 * this function - loadFeed fails closed instead.
 */
function normalizeFeed(raw) {
    if (!isObj(raw) || !Array.isArray(raw.posts) || !Array.isArray(raw.interactions)) {
        return emptyFeed();
    }
    const posts = [];
    const postIds = new Set();
    for (const item of raw.posts) {
        const post = storedPost(item);
        if (!post || postIds.has(post.id)) {
            continue;
        }
        postIds.add(post.id);
        posts.push(post);
    }
    const interactions = [];
    const interactionIds = new Set();
    for (const item of raw.interactions) {
        const interaction = storedInteraction(item, postIds);
        if (!interaction || interactionIds.has(interaction.id)) {
            continue;
        }
        interactionIds.add(interaction.id);
        interactions.push(interaction);
    }
    return { version: 1, posts, interactions };
}

/**
 * The feed lives in the user files directory, not in extension settings. Both
 * extensionSettings and accountStorage serialise into settings.json, and every write there
 * re-serialises the whole file and copies it into a 50-deep backup rotation.
 *
 * Fails closed: an unreadable configured feed throws instead of coming back as an empty
 * timeline, because a writable empty feed would let the next save erase real history.
 */
export async function loadFeed(sessionId = ensureActiveSession().id) {
    const settings = getSettings();
    const session = settings.sessions[sessionId];
    if (!session) {
        throw new Error('That timeline session no longer exists.');
    }
    const path = session.feedPath || (sessionId === 'legacy' ? settings.shards[0] : '');
    if (!path) {
        return emptyFeed();
    }
    const url = `${path}?t=${Date.now()}`;
    let text = '';
    try {
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        // Read as text, not json(): browsers word the parse failure differently, and the
        // body itself is the only thing that says what actually went wrong.
        text = await response.text();
    } catch (error) {
        console.error('[Hopper] the saved timeline could not be fetched', url, error);
        throw new Error(`The saved timeline could not be read from ${path} (${error.message}). Try again, or reset the timeline to start over.`);
    }
    // An interrupted or failed write leaves an empty file behind. There is no history in
    // there to protect, so start over rather than locking the user out of their feed.
    if (!text.trim()) {
        return emptyFeed();
    }
    let raw = parseJson(text);
    if (raw === null && /^[A-Za-z0-9+/\s=]+$/.test(text)) {
        // Some hosts store the upload payload verbatim instead of decoding it, leaving the
        // feed on disk as base64. Read it back rather than calling the timeline unreadable.
        raw = parseJson(fromBase64(text));
    }
    if (!isObj(raw) || !Array.isArray(raw.posts) || !Array.isArray(raw.interactions)) {
        console.error('[Hopper] the saved timeline is not a timeline file', url, text.slice(0, 300));
        throw new Error(`The file at ${path} is not a timeline - it starts with "${text.trim().slice(0, 40)}". If that looks like a web page, the server did not hand back the saved file.`);
    }
    return normalizeFeed(raw);
}

function parseJson(text) {
    try {
        return JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch {
        return null;
    }
}

function fromBase64(text) {
    try {
        const binary = atob(text.replace(/\s/g, ''));
        return new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
    } catch {
        return '';
    }
}

/** Reads a JSON response, and says what actually arrived when the body is not JSON. */
async function readJson(response, what) {
    const text = await response.text();
    const parsed = parseJson(text);
    if (parsed === null) {
        console.error(`[Hopper] ${what} did not answer with JSON`, response.url, text.slice(0, 300));
        throw new Error(`${what} answered with "${text.trim().slice(0, 40)}" instead of data. Is this SillyBunny tab still signed in?`);
    }
    return parsed;
}

function toBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
}

function sessionFileName(session) {
    const existing = session.feedPath.split('/').pop();
    if (existing) {
        return existing;
    }
    return session.id === 'legacy'
        ? FEED_FILE
        : `twitterlike-feed-${session.id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80)}.json`;
}

async function uploadFeed(feed, sessionId, signal) {
    const context = ctx();
    const session = getSession(sessionId);
    if (!session) {
        throw new Error('That timeline session no longer exists.');
    }
    const body = JSON.stringify({ version: 1, posts: feed.posts, interactions: feed.interactions });
    const response = await fetch('/api/files/upload', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({ name: sessionFileName(session), data: toBase64(body) }),
        signal,
    });
    if (!response.ok) {
        throw new Error(`Could not save the feed (${response.status})`);
    }
    const { path } = await readJson(response, 'The file upload');
    const settings = getSettings();
    if (settings.sessions[sessionId]?.feedPath !== path) {
        updateSettings({
            sessions: {
                ...settings.sessions,
                [sessionId]: { ...settings.sessions[sessionId], feedPath: path },
            },
            ...(sessionId === 'legacy' ? { shards: [path] } : {}),
        });
    }
    return path;
}

// The picker's accept="image/*" is advisory only; validate before buffering anything.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Attaches a picture the user picked from their device to a post they are writing. */
export async function uploadImage(file) {
    const context = ctx();
    // SVG is refused on purpose: it can carry scripts and would be served from the host origin.
    if (!file || typeof file.type !== 'string' || !file.type.startsWith('image/') || file.type === 'image/svg+xml') {
        throw new Error('That file is not a supported image.');
    }
    if (file.size > MAX_IMAGE_BYTES) {
        throw new Error('That image is too large - the limit is 10 MB.');
    }
    const buffer = await file.arrayBuffer();
    let binary = '';
    for (const byte of new Uint8Array(buffer)) {
        binary += String.fromCharCode(byte);
    }
    const extension = (file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
    const name = `twitterlike-${context.uuidv4()}.${extension}`;
    const response = await fetch('/api/files/upload', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({ name, data: btoa(binary) }),
    });
    if (!response.ok) {
        throw new Error(`Could not upload that image (${response.status})`);
    }
    const { path } = await readJson(response, 'The image upload');
    return path;
}

const saveStates = new Map();

function snapshotFeed(feed) {
    return structuredClone({ version: 1, posts: feed.posts, interactions: feed.interactions });
}

/**
 * One upload at a time, so an older write can never finish after a newer one. A failed
 * upload keeps its snapshot queued (unless something newer arrived) so flushFeed can
 * retry it - data is only dropped from the queue once it is durable.
 */
function saveState(sessionId) {
    let state = saveStates.get(sessionId);
    if (!state) {
        state = { pending: null, timer: 0, chain: Promise.resolve(), latestRevision: 0 };
        saveStates.set(sessionId, state);
    }
    return state;
}

function queueFeed(feed, sessionId) {
    const state = saveState(sessionId);
    clearTimeout(state.timer);
    state.timer = 0;
    state.pending = {
        revision: ++state.latestRevision,
        feed: snapshotFeed(feed),
    };
}

function enqueueSave(sessionId) {
    const state = saveState(sessionId);
    clearTimeout(state.timer);
    state.timer = 0;
    const pending = state.pending;
    state.pending = null;
    if (!pending) {
        return state.chain;
    }
    const attempt = state.chain.then(() => uploadFeed(pending.feed, sessionId));
    state.chain = attempt.then(() => {}, error => {
        console.error('[Hopper] feed save failed', error);
        // A failed old upload must never come back from the dead after a newer revision.
        if (state.latestRevision === pending.revision && !state.pending) {
            state.pending = pending;
        }
    });
    return attempt;
}

async function flushSession(sessionId) {
    const state = saveState(sessionId);
    clearTimeout(state.timer);
    state.timer = 0;
    while (true) {
        const chain = state.chain;
        await chain;
        // Another caller may have appended a write while this flush was waiting.
        if (chain !== state.chain) {
            continue;
        }
        if (!state.pending) {
            return;
        }
        // One explicit attempt per loop. Failure is retained for the next flush and
        // propagated to the caller instead of spinning forever.
        await enqueueSave(sessionId);
    }
}

/** Saves pending visible edits first, then commits this exact transactional snapshot. */
export async function writeFeed(feed, sessionId = ensureActiveSession().id, { signal } = {}) {
    await flushSession(sessionId);
    const state = saveState(sessionId);
    const snapshot = snapshotFeed(feed);
    const attempt = state.chain.then(() => {
        signal?.throwIfAborted();
        return uploadFeed(snapshot, sessionId, signal);
    });
    // Keep the queue usable after a rejected transaction, but let this caller see its error.
    state.chain = attempt.then(() => {}, () => {});
    return attempt;
}

/** Liking three posts in a row should be one write, not three. */
export function saveFeedDebounced(feed, delay = 1200, sessionId = ensureActiveSession().id) {
    const state = saveState(sessionId);
    queueFeed(feed, sessionId);
    state.timer = setTimeout(() => { enqueueSave(sessionId).catch(() => {}); }, delay);
}

/** Waits out any in-flight write, then writes whatever is still unsaved. */
export async function flushFeed(sessionId = '') {
    if (sessionId) {
        return flushSession(sessionId);
    }
    return Promise.all([...saveStates.keys()].map(flushSession));
}

// --- generation -----------------------------------------------------------

export function listConnectionProfiles() {
    const context = ctx();
    const service = context.ConnectionManagerRequestService;
    if (!service) {
        return [];
    }
    try {
        return service.getSupportedProfiles() ?? [];
    } catch {
        // Connection Manager is disabled; the caller falls back to generateRaw.
        return [];
    }
}

/**
 * ConnectionManagerRequestService takes a message array verbatim - no chat history, no
 * character card, no macro substitution. generateQuietPrompt cannot be used here: its
 * skipWIAN only skips World Info and the Author's Note, so the open chat would leak into
 * every post, and its forceChId only works in group chats.
 */
async function runGeneration(messages, maxTokens, signal) {
    const context = ctx();
    const settings = getSettings();
    const service = context.ConnectionManagerRequestService;

    if (settings.profileId && service) {
        const result = await service.sendRequest(settings.profileId, messages, maxTokens, {
            stream: false,
            signal,
            extractData: true,
            includePreset: false,
            includeInstruct: false,
        });
        return typeof result === 'string' ? result : (result?.content ?? '');
    }

    // Fallback: also history-free, but it prefixes turns with name1/name2 and runs
    // substituteParams with the globals, so the caller must not rely on {{macros}}.
    const system = messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n');
    const prompt = messages.filter(message => message.role !== 'system').map(message => message.content).join('\n\n');
    return context.generateRaw({ prompt, systemPrompt: system, responseLength: maxTokens, signal });
}

async function generateProfilesFor(accounts, allAccounts, signal) {
    if (!accounts.length) {
        return {};
    }
    const targets = new Set(accounts.map(account => account.key));
    const others = allAccounts.filter(account => !targets.has(account.key));
    const messages = buildProfileMessages(accounts);
    const maxTokens = PROFILE_MAX_TOKENS_BASE * (1 + accounts.length);
    const raw = await runGeneration(messages, maxTokens, signal);
    try {
        return parseProfileResponse(raw, accounts, others);
    } catch (error) {
        console.warn('[Hopper] profile generation returned unusable JSON', error);
        return {};
    }
}

/**
 * Writes the persona's timeline profile (name, handle, bio, location) with the same
 * connection that writes posts, from the persona description. Returns the profile or null.
 */
export async function generatePersonaProfile(sessionId = ensureActiveSession().id, { signal } = {}) {
    const accounts = await currentAccounts(sessionId);
    const persona = accounts.find(account => account.kind === KIND_PERSONA) ?? null;
    if (!persona) {
        throw new Error('Set a persona for this timeline first.');
    }
    const profiles = await generateProfilesFor([persona], accounts, signal);
    const profile = profiles[persona.key];
    if (!profile) {
        return null;
    }
    return { name: profile.name, handle: profile.handle, bio: profile.bio, location: profile.location };
}

export async function generatePostImage(prompt, signal) {
    const context = ctx();
    if (typeof context.executeSlashCommandsWithOptions !== 'function') {
        return '';
    }
    try {
        // The prompt is model output, so it is quoted and escaped: unquoted, its text could
        // parse as named /imagine flags (quiet=false gallery=true ...) instead of the image
        // description. quiet=true returns the URL instead of posting into the open chat.
        const quoted = `"${String(prompt ?? '').replace(/[\\"]/g, '\\$&').replace(/\s+/g, ' ').trim()}"`;
        const result = await context.executeSlashCommandsWithOptions(
            `/imagine quiet=true gallery=false ${quoted}`,
            { handleExecutionErrors: true, signal },
        );
        return typeof result?.pipe === 'string' ? result.pipe : '';
    } catch (error) {
        console.warn('[Hopper] image generation failed, publishing text only', error);
        return '';
    }
}

/**
 * One refresh: pick the cast, give anyone new a profile, ask for a batch of activity, then
 * re-check every quota locally before storing anything. The model is never trusted to have
 * obeyed the prompt.
 */
export async function runRefresh({ sessionId = ensureActiveSession().id, feed, signal, onProgress = () => {}, onPartial = () => {}, topic = '' } = {}) {
    const settings = getSettings();
    const session = settings.sessions[sessionId];
    if (!session) {
        throw new Error('That timeline session no longer exists.');
    }
    const accounts = await currentAccounts(sessionId);
    const persona = accounts.find(account => account.kind === KIND_PERSONA) ?? null;

    const active = selectParticipants(accounts, settings, {
        posts: feed.posts,
        interactions: feed.interactions,
    });
    if (!active.length && !session.ambient) {
        throw new Error('Invite a character first, or let strangers join in.');
    }

    // Only the selected cast gets a profile, so an install with 200 characters does not
    // send 200 cards on the first refresh.
    const needProfiles = active.filter(account => account.kind === KIND_CHARACTER && !account.hasProfile);
    if (needProfiles.length) {
        onProgress('Writing profiles...');
        const profiles = await generateProfilesFor(needProfiles, accounts, signal);
        if (Object.keys(profiles).length) {
            // Fresh read: the user may have edited profiles while generation was running.
            updateSettings({ profiles: { ...getSettings().profiles, ...profiles } });
        }
    }

    // Re-derive so freshly generated handles are the ones the prompt advertises.
    const freshAccounts = await currentAccounts(sessionId);
    const activeKeys = new Set(active.map(account => account.key));
    const freshActive = freshAccounts.filter(account => activeKeys.has(account.key));
    const freshPersona = freshAccounts.find(account => account.kind === KIND_PERSONA) ?? persona;
    const current = getSettings();

    const newId = () => ctx().uuidv4();
    const batch = {
        sessionId, feed, signal, onProgress, onPartial,
        accounts: freshAccounts, active: freshActive, persona: freshPersona, session, settings: current,
        activeKeys, newId, topic,
    };

    if (current.incremental) {
        return runIncrementalRefresh(batch);
    }

    onProgress(topic ? `Writing posts about ${topic}...` : 'Writing posts...');
    const messages = buildRefreshMessages({
        accounts: freshAccounts,
        active: freshActive,
        persona: freshPersona,
        session,
        posts: feed.posts,
        interactions: feed.interactions,
        settings: current,
        now: Date.now(),
        localTime: new Date().toLocaleString(),
        strangers: session.ambient ? MAX_NEW_STRANGERS_PER_REFRESH : 0,
        // A topic refresh keeps the trending bar as it is; a plain one writes a fresh set.
        trends: !topic,
        topic,
    });
    const parsed = await generateBatch(messages, REFRESH_MAX_TOKENS, batch, { throwOnFailure: true });
    const result = materializeRefresh(parsed, {
        accounts: freshAccounts,
        // The prompt asks for active accounts only; this enforces it locally, so a
        // malformed batch cannot act through an invited-but-deactivated character.
        allowedActorKeys: [...activeKeys],
        settings: current,
        posts: feed.posts,
        interactions: feed.interactions,
        newId,
        now: Date.now(),
        strangerLimit: session.ambient ? MAX_NEW_STRANGERS_PER_REFRESH : 0,
    });
    await commitBatch(result, batch);
    updateSession(sessionId, { lastRefreshAt: Date.now() });
    return result;
}

/** Asks the model once, retrying a malformed answer once with a correction. Null when it gives up and throwOnFailure is off. */
async function generateBatch(messages, maxTokens, { signal, onProgress, active }, { throwOnFailure = false } = {}) {
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const attemptMessages = attempt === 0
            ? messages
            : [...messages, { role: 'user', content: buildCorrectionMessage(lastError, active.map(a => a.handle)) }];
        const raw = await runGeneration(attemptMessages, maxTokens, signal);
        try {
            const parsed = parseRefreshResponse(raw);
            if (parsed.salvaged) {
                onProgress('That came back cut off, keeping the complete part...');
            }
            return parsed;
        } catch (error) {
            lastError = error.message;
            if (attempt === 1) {
                if (throwOnFailure) {
                    throw new Error(`The model did not return usable JSON (${error.message}).`);
                }
                return null;
            }
            onProgress('That came back malformed, asking again...');
        }
    }
    return null;
}

/**
 * Draws any images, writes the whole future feed (the commit point), then mirrors the
 * new rows into the in-memory feed and the session. Shared by the batch and the
 * one-post-at-a-time paths so both persist the same way.
 */
async function commitBatch(result, { sessionId, feed, signal, onProgress, onPartial, settings }) {
    if (settings.images.enabled) {
        const withPrompts = result.posts.filter(post => post.image?.prompt);
        for (const [index, post] of withPrompts.entries()) {
            signal?.throwIfAborted();
            onProgress(`Drawing image ${index + 1} of ${withPrompts.length}...`);
            const url = await generatePostImage(post.image.prompt, signal);
            // A failed image publishes a clean text-only post rather than exposing the prompt.
            post.image = url ? { url, prompt: post.image.prompt } : null;
        }
    }

    signal?.throwIfAborted();

    // Persist the whole future state before touching anything the user can see: a failed
    // save must not leave phantom posts that vanish on reload while lastRefreshAt claims
    // the refresh happened.
    const candidate = {
        version: 1,
        posts: [...feed.posts, ...result.posts],
        interactions: [...feed.interactions, ...result.interactions],
    };
    await writeFeed(candidate, sessionId, { signal });

    // A successful upload is the commit point. Cancellation after it must not leave the
    // durable feed ahead of the in-memory feed and refresh timestamp.
    feed.posts.push(...result.posts);
    feed.interactions.push(...result.interactions);

    if (result.strangers.length) {
        // Strangers are session records: a stranger a later refresh talks to must still exist.
        const freshSession = getSession(sessionId);
        updateSession(sessionId, { strangers: [...(freshSession?.strangers ?? []), ...result.strangers] });
    }

    if (result.trends?.length) {
        // Made-up trending topics: the newest set replaces the last one.
        updateSession(sessionId, { trends: result.trends });
    }

    if (result.follows.length) {
        // Merge into the freshest settings so a follow made manually while the model was
        // thinking is not overwritten by this refresh's snapshot.
        const freshSession = getSession(sessionId);
        const follows = { ...freshSession.follows };
        for (const { actorKey, targetKey } of result.follows) {
            follows[actorKey] = [...new Set([...(follows[actorKey] ?? []), targetKey])];
        }
        updateSession(sessionId, { follows });
    }

    onPartial(result);
}

/**
 * One post per request: each turn names an author, takes exactly one post plus the
 * reactions to it, commits it and shows it, then moves on. More requests, but the first
 * post lands in seconds and the timeline fills in as it goes.
 */
async function runIncrementalRefresh(batch) {
    const { sessionId, feed, signal, onProgress, accounts, active, persona, session, settings, activeKeys, newId, topic } = batch;
    const quotas = settings.quotas;
    const total = Math.max(1, quotas.posts);
    const remaining = { replies: quotas.replies, reposts: quotas.reposts, likes: quotas.likes };
    let strangersLeft = session.ambient ? MAX_NEW_STRANGERS_PER_REFRESH : 0;
    const cast = active.filter(account => account.kind === KIND_CHARACTER);
    const all = { posts: [], interactions: [], follows: [], strangers: [], trends: [], warnings: [] };
    let emptyTurns = 0;
    let liveAccounts = accounts;

    for (let index = 1; index <= total; index += 1) {
        signal?.throwIfAborted();
        const author = cast.length ? cast[(index - 1) % cast.length] : null;
        if (!author && strangersLeft <= 0 && !liveAccounts.some(account => account.kind === KIND_AMBIENT && activeKeys.has(account.key))) {
            break;
        }
        onProgress(`Post ${index} of ${total}...`);
        const turnSettings = { ...settings, quotas: { posts: 1, replies: remaining.replies, reposts: remaining.reposts, likes: remaining.likes } };
        const messages = buildRefreshMessages({
            accounts: liveAccounts,
            active: liveAccounts.filter(account => activeKeys.has(account.key)),
            persona,
            session,
            posts: feed.posts,
            interactions: feed.interactions,
            settings: turnSettings,
            now: Date.now(),
            localTime: new Date().toLocaleString(),
            strangers: strangersLeft,
            turn: { index, total, author, remaining },
            // One set of made-up trends per refresh is plenty; the first turn writes them, and a topic refresh keeps the bar.
            trends: index === 1 && !topic,
            topic,
        });
        const parsed = await generateBatch(messages, TURN_MAX_TOKENS, { ...batch, active: liveAccounts.filter(account => activeKeys.has(account.key)) });
        if (!parsed) {
            all.warnings.push(`turn ${index}: the model did not return usable JSON, skipped`);
            emptyTurns += 1;
            if (emptyTurns >= 2) {
                break;
            }
            continue;
        }
        const result = materializeRefresh(parsed, {
            accounts: liveAccounts,
            allowedActorKeys: [...activeKeys],
            settings: turnSettings,
            posts: feed.posts,
            interactions: feed.interactions,
            newId,
            now: Date.now(),
            strangerLimit: strangersLeft,
        });
        await commitBatch(result, batch);
        for (const key of ['posts', 'interactions', 'follows', 'strangers', 'trends', 'warnings']) {
            all[key].push(...result[key]);
        }
        for (const item of result.interactions) {
            if (item.type === 'reply') {
                remaining.replies = Math.max(0, remaining.replies - 1);
            } else if (item.type === 'repost') {
                remaining.reposts = Math.max(0, remaining.reposts - 1);
            } else {
                remaining.likes = Math.max(0, remaining.likes - 1);
            }
        }
        if (result.strangers.length) {
            strangersLeft = Math.max(0, strangersLeft - result.strangers.length);
            // New strangers join the cast for the rest of the refresh.
            liveAccounts = await currentAccounts(sessionId);
            for (const stranger of result.strangers) {
                activeKeys.add(`${KIND_AMBIENT}:${stranger.id}`);
            }
        }
        emptyTurns = result.posts.length || result.interactions.length ? 0 : emptyTurns + 1;
        if (emptyTurns >= 2) {
            all.warnings.push('two quiet turns in a row, stopped early');
            break;
        }
    }

    updateSession(sessionId, { lastRefreshAt: Date.now() });
    return all;
}

// --- carryover ------------------------------------------------------------

function chatAccountKeys(accounts) {
    const context = ctx();
    const keys = new Set();
    const persona = accounts.find(account => account.kind === KIND_PERSONA);
    if (persona) {
        keys.add(persona.key);
    }
    const characters = context.characters ?? [];
    const active = characters[context.characterId];
    if (active?.avatar) {
        keys.add(`${KIND_CHARACTER}:${active.avatar}`);
    }
    const group = (context.groups ?? []).find(item => String(item.id) === String(context.groupId));
    for (const member of group?.members ?? []) {
        keys.add(`${KIND_CHARACTER}:${member}`);
    }
    return keys;
}

export function clearCarryover() {
    ctx().setExtensionPrompt(EXT_PROMPT_KEY, '', EXTENSION_PROMPT_TYPE_IN_CHAT, 1, false, EXTENSION_PROMPT_ROLE_SYSTEM);
}

/**
 * Injects a "Recent Social Media Activity" block into the current chat's prompt. Off by
 * default; clears itself whenever it has nothing to say, so a disabled or empty feed never
 * leaves a stale block behind.
 */
export async function applyCarryover(feed, sessionId = ensureActiveSession().id, { isCurrent = () => true } = {}) {
    const settings = getSettings();
    if (!settings.carry.enabled) {
        if (isCurrent()) {
            clearCarryover();
        }
        return '';
    }

    const accounts = await currentAccounts(sessionId);
    const since = Date.now() - settings.carry.hours * 3600 * 1000;
    const lines = digestLines(feed.posts, feed.interactions, accounts, {
        since,
        limit: settings.carry.items,
        keys: [...chatAccountKeys(accounts)],
    });

    let block = buildCarryoverBlock(lines);
    const context = ctx();
    if (block && typeof context.getTokenCountAsync === 'function') {
        let kept = [...lines];
        while (kept.length && await context.getTokenCountAsync(buildCarryoverBlock(kept)) > 1024) {
            kept.shift();
        }
        block = buildCarryoverBlock(kept);
    }

    if (!block) {
        if (isCurrent()) {
            clearCarryover();
        }
        return '';
    }
    if (!isCurrent()) {
        return '';
    }
    context.setExtensionPrompt(
        EXT_PROMPT_KEY, block, EXTENSION_PROMPT_TYPE_IN_CHAT, settings.carry.depth, false, EXTENSION_PROMPT_ROLE_SYSTEM,
    );
    return block;
}
