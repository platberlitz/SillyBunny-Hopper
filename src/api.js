// Every call into the SillyBunny host lives here. Nothing in this file touches the DOM.

import {
    EXT_PROMPT_KEY,
    KIND_AMBIENT,
    KIND_CHARACTER,
    KIND_PERSONA,
    POST_MAX_CHARS,
    REPLY_MAX_CHARS,
    SETTINGS_KEY,
    buildCarryoverBlock,
    buildCorrectionMessage,
    buildProfileMessages,
    buildRefreshMessages,
    deriveAccounts,
    digestLines,
    inertText,
    materializeRefresh,
    normalizeSettings,
    parseProfileResponse,
    parseRefreshResponse,
    selectParticipants,
    MAX_NEW_STRANGERS_PER_REFRESH,
    MAX_POLLS_PER_REFRESH,
    reasoningOverridesFrom,
    shareQuota,
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
/** How much of the open roleplay chat a character may react to, when the user turns that on. */
const SCENE_MESSAGE_LIMIT = 12;
const SCENE_CHAR_BUDGET = 4000;
const REQUEST_TIMEOUT_MS = 30_000;

function requestSignal(signal) {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

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

/**
 * Removes a timeline for good: its feed file on the host, its session entry and any active
 * pointer at it. Other timelines and the shared character profiles are untouched. If it was
 * the last one, the next open creates a fresh empty timeline.
 */
export async function deleteSession(sessionId) {
    const context = ctx();
    const settings = getSettings();
    const session = settings.sessions[sessionId];
    if (!session) {
        throw new Error('That timeline session no longer exists.');
    }
    const path = session.feedPath || (sessionId === 'legacy' ? settings.shards[0] : '');
    if (path && isFeedPath(path)) {
        const response = await fetch('/api/files/delete', {
            method: 'POST',
            headers: context.getRequestHeaders(),
            body: JSON.stringify({ path }),
            signal: requestSignal(),
        });
        // A file that is already gone is the outcome we wanted.
        if (!response.ok && response.status !== 404) {
            throw new Error(`Could not delete the timeline file (${response.status})`);
        }
    } else if (path) {
        console.warn('[Hopper] refusing to delete a non-Hopper file while removing its local timeline', path);
    }
    const fresh = getSettings();
    const sessions = { ...fresh.sessions };
    delete sessions[sessionId];
    updateSettings({
        sessions,
        activeSessionId: fresh.activeSessionId === sessionId ? '' : fresh.activeSessionId,
        activeSessionByPersona: Object.fromEntries(Object.entries(fresh.activeSessionByPersona).filter(([, id]) => id !== sessionId)),
        ...(sessionId === 'legacy' ? { shards: [] } : {}),
    });
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
    if (!account || account.kind === KIND_AMBIENT || !account.entityId) {
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
const MAX_DATE_VALUE = 8_640_000_000_000_000;
const MAX_FEED_BYTES = 20 * 1024 * 1024;
const MAX_ENCODED_FEED_BYTES = Math.ceil(MAX_FEED_BYTES / 3) * 4 + 1024;

const isObj = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const storedText = (value, max = 0) => (typeof value === 'string' ? (max ? value.slice(0, max) : value) : '');
const storedId = value => {
    const id = storedText(value, 120).trim();
    return /^[a-zA-Z0-9_-]+$/.test(id) ? id : '';
};
const storedTime = value => {
    const number = Number(value);
    return Number.isFinite(number) && Math.abs(number) <= MAX_DATE_VALUE ? number : 0;
};

function storedSnapshot(raw) {
    if (!isObj(raw)) {
        return null;
    }
    const handle = storedText(raw.handle, 20);
    return {
        key: storedText(raw.key, 520),
        kind: storedText(raw.kind, 20),
        handle: /^[a-z0-9_]{1,20}$/.test(handle) ? handle : '',
        name: storedText(raw.name, 120),
    };
}

function storedPost(raw) {
    const id = storedId(raw?.id);
    const authorKey = storedText(raw?.authorKey, 520).trim();
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
        body: storedText(raw.body, POST_MAX_CHARS),
        createdAt: storedTime(raw.createdAt),
        image: isObj(raw.image) && typeof raw.image.url === 'string'
            ? {
                url: raw.image.url.slice(0, 4000),
                prompt: storedText(raw.image.prompt, 2000),
                ...(Number.isInteger(raw.image.width) && raw.image.width > 0 && Number.isInteger(raw.image.height) && raw.image.height > 0
                    ? { width: raw.image.width, height: raw.image.height }
                    : {}),
            }
            : null,
        poll: pollRaw && typeof pollRaw.question === 'string' && options.length >= 2
            ? {
                question: pollRaw.question.slice(0, 200),
                options: options.map((option, index) => ({
                    id: storedText(option.id, 120) || `option-${index}`,
                    text: option.text.slice(0, 120),
                })),
            }
            : null,
        authorSnapshot: storedSnapshot(raw.authorSnapshot),
    };
}

function storedInteraction(raw, validPostIds) {
    const id = storedId(raw?.id);
    const postId = storedId(raw?.postId);
    const actorKey = storedText(raw?.actorKey, 520).trim();
    const type = storedText(raw?.type, 20);
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
        content: storedText(raw.content, REPLY_MAX_CHARS) || null,
        parentInteractionId: storedId(raw.parentInteractionId) || null,
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
    if (!isFeedPath(path)) {
        throw new Error('The saved timeline path is not a Hopper timeline file.');
    }
    const url = `${path}?t=${Date.now()}`;
    let text = '';
    try {
        const response = await fetch(url, { cache: 'no-store', signal: requestSignal() });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        // Read as text, not json(): browsers word the parse failure differently, and the
        // body itself is the only thing that says what actually went wrong.
        text = await response.text();
        const encoded = /^[A-Za-z0-9+/\s=]+$/.test(text);
        if (text.length > MAX_ENCODED_FEED_BYTES || (text.length > MAX_FEED_BYTES && !encoded)) {
            throw new Error('the file is larger than 20 MB');
        }
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
        const decoded = fromBase64(text);
        if (decoded.length > MAX_FEED_BYTES) {
            throw new Error(`The saved timeline at ${path} is larger than 20 MB.`);
        }
        raw = parseJson(decoded);
    }
    if (!isObj(raw) || !Array.isArray(raw.posts) || !Array.isArray(raw.interactions)) {
        console.error('[Hopper] the saved timeline is not a timeline file', url, text.slice(0, 300));
        throw new Error(`The file at ${path} is not a timeline - it starts with "${text.trim().slice(0, 40)}". If that looks like a web page, the server did not hand back the saved file.`);
    }
    if (Number(raw.version ?? 1) > 1) {
        throw new Error(`The file at ${path} uses a newer timeline format.`);
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

function isFeedPath(path) {
    return typeof path === 'string' && /^\/user\/files\/twitterlike-feed(?:-[a-zA-Z0-9_-]+)?\.json$/.test(path);
}

function shortHash(value) {
    let hash = 2166136261;
    for (const char of String(value)) {
        hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

function sessionFileName(session) {
    const existing = session.feedPath.split('/').pop();
    if (existing && isFeedPath(`/user/files/${existing}`)) {
        return existing;
    }
    if (session.id === 'legacy') {
        return FEED_FILE;
    }
    const safe = session.id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || 'timeline';
    const changed = safe !== session.id;
    return `twitterlike-feed-${safe}${changed ? `-${shortHash(session.id)}` : ''}.json`;
}

async function uploadFeed(feed, sessionId, signal) {
    const context = ctx();
    const session = getSession(sessionId);
    if (!session) {
        throw new Error('That timeline session no longer exists.');
    }
    const body = JSON.stringify({ version: 1, posts: feed.posts, interactions: feed.interactions });
    if (body.length > MAX_FEED_BYTES) {
        throw new Error('The feed is too large to save safely (20 MB limit).');
    }
    const response = await fetch('/api/files/upload', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({ name: sessionFileName(session), data: toBase64(body) }),
        signal: requestSignal(signal),
    });
    if (!response.ok) {
        throw new Error(`Could not save the feed (${response.status})`);
    }
    const uploaded = await readJson(response, 'The file upload');
    const path = isFeedPath(uploaded.path) ? uploaded.path : session.feedPath;
    if (!isFeedPath(path)) {
        throw new Error('The file upload did not return a valid Hopper timeline path.');
    }
    if (!isFeedPath(uploaded.path)) {
        // The endpoint already overwrote the trusted filename. Keep memory on that commit
        // instead of reporting failure and letting an older in-memory feed overwrite it.
        console.error('[Hopper] the feed was saved but the upload response omitted its path; retaining the existing pointer');
    }
    const settings = getSettings();
    const firstPath = !settings.sessions[sessionId]?.feedPath;
    if (settings.sessions[sessionId]?.feedPath !== path) {
        updateSettings({
            sessions: {
                ...settings.sessions,
                [sessionId]: { ...settings.sessions[sessionId], feedPath: path },
            },
            ...(sessionId === 'legacy' ? { shards: [path] } : {}),
        });
        if (firstPath && typeof context.saveSettings === 'function') {
            try {
                await context.saveSettings();
            } catch (error) {
                // The feed upload already committed. Keep memory aligned with it and let the
                // debounced settings write retry the new pointer instead of rolling back history.
                console.error('[Hopper] the feed was saved but its path could not be flushed immediately', error);
            }
        }
    }
    return path;
}

// The picker's accept="image/*" is advisory only; validate before buffering anything.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = new Map([
    ['image/png', 'png'],
    ['image/jpeg', 'jpg'],
    ['image/gif', 'gif'],
    ['image/webp', 'webp'],
]);

function hasImageSignature(bytes, type) {
    if (type === 'image/png') return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    if (type === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (type === 'image/gif') return String.fromCharCode(...bytes.slice(0, 4)) === 'GIF8';
    return String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
}

/** Attaches a picture the user picked from their device to a post they are writing. */
export async function uploadImage(file) {
    const context = ctx();
    const extension = IMAGE_TYPES.get(file?.type);
    if (!extension) {
        throw new Error('That file is not a supported image.');
    }
    if (file.size > MAX_IMAGE_BYTES) {
        throw new Error('That image is too large - the limit is 10 MB.');
    }
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    if (!hasImageSignature(bytes, file.type)) {
        throw new Error('That file does not match its image type.');
    }
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    const name = `twitterlike-${context.uuidv4()}.${extension}`;
    const response = await fetch('/api/files/upload', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({ name, data: btoa(binary) }),
        signal: requestSignal(),
    });
    if (!response.ok) {
        throw new Error(`Could not upload that image (${response.status})`);
    }
    const { path } = await readJson(response, 'The image upload');
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
        throw new Error('The image upload did not return a valid path.');
    }
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

export function listConnectionProfiles({ throwOnError = false } = {}) {
    const context = ctx();
    const service = context.ConnectionManagerRequestService;
    if (!service) {
        return [];
    }
    try {
        return service.getSupportedProfiles() ?? [];
    } catch (error) {
        if (throwOnError) {
            throw new Error('Connection Manager profiles could not be read.', { cause: error });
        }
        return [];
    }
}

/**
 * ConnectionManagerRequestService takes a message array verbatim - no chat history, no
 * character card, no macro substitution. generateQuietPrompt cannot be used here: its
 * skipWIAN only skips World Info and the Author's Note, so the open chat would leak into
 * every post, and its forceChId only works in group chats.
 */
/** The reasoning settings of the chosen profile's preset, for the fields the profile leaves unset. */
function reasoningOverrides(service, profileId) {
    try {
        const profile = service.getProfile?.(profileId);
        if (!profile?.preset) {
            return {};
        }
        const preset = ctx().getPresetManager?.('openai')?.getCompletionPresetByName?.(profile.preset);
        return reasoningOverridesFrom(profile, preset);
    } catch (error) {
        console.warn('[Hopper] could not read the reasoning settings of that connection profile', error);
        return {};
    }
}

async function runGeneration(messages, maxTokens, signal) {
    const context = ctx();
    const settings = getSettings();
    const service = context.ConnectionManagerRequestService;

    if (settings.profileId) {
        if (!service || !listConnectionProfiles({ throwOnError: true }).some(profile => profile?.id === settings.profileId)) {
            throw new Error('The selected connection profile is unavailable. Choose another connection in Hopper settings.');
        }
        const result = await service.sendRequest(settings.profileId, messages, maxTokens, {
            stream: false,
            signal,
            extractData: true,
            includePreset: false,
            includeInstruct: false,
        }, reasoningOverrides(service, settings.profileId));
        return typeof result === 'string' ? result : (result?.content ?? '');
    }

    // Fallback: also history-free, but it prefixes turns with name1/name2 and runs
    // substituteParams with the globals, so the caller must not rely on {{macros}}.
    const system = messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n');
    const prompt = messages.filter(message => message.role !== 'system').map(message => message.content).join('\n\n');
    return context.generateRaw({ prompt, systemPrompt: system, responseLength: maxTokens, signal });
}

async function generateProfilesFor(accounts, allAccounts, signal, { avoid = null } = {}) {
    if (!accounts.length) {
        return {};
    }
    const targets = new Set(accounts.map(account => account.key));
    const others = allAccounts.filter(account => !targets.has(account.key));
    const avoided = avoid ?? others.map(account => account.handle);
    const messages = buildProfileMessages(accounts, { avoid: avoided });
    const raw = await runGeneration(messages, getSettings().maxTokens, signal);
    try {
        return parseProfileResponse(raw, accounts, others, avoided);
    } catch (error) {
        console.warn('[Hopper] profile generation returned unusable JSON', error);
        return {};
    }
}

/**
 * Generates the persona's timeline profile (name, handle, bio, location) with the same
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

/**
 * Writes a character a fresh timeline profile (name, handle, bio, location), ruling out its
 * current handle and everyone else's, and saves it. Returns the profile or null.
 */
export async function regenerateProfile(accountKey, sessionId = ensureActiveSession().id, { signal } = {}) {
    const accounts = await currentAccounts(sessionId);
    const account = accounts.find(item => item.key === accountKey) ?? null;
    if (!account || account.kind !== KIND_CHARACTER) {
        throw new Error('Only characters can be given a new profile here.');
    }
    const profiles = await generateProfilesFor([account], accounts, signal, { avoid: accounts.map(item => item.handle) });
    const profile = profiles[account.key];
    if (!profile) {
        return null;
    }
    updateSettings({ profiles: { ...getSettings().profiles, [account.key]: profile } });
    return profile;
}

/**
 * Fresh profiles for every invited character of a timeline, in one request. Every current
 * handle is ruled out, so they all change. Returns how many profiles were written.
 */
export async function regenerateAllProfiles(sessionId = ensureActiveSession().id, { signal } = {}) {
    const accounts = await currentAccounts(sessionId);
    const characters = accounts.filter(account => account.kind === KIND_CHARACTER);
    if (!characters.length) {
        throw new Error('Invite at least one character first.');
    }
    const profiles = await generateProfilesFor(characters, accounts, signal, { avoid: accounts.map(account => account.handle) });
    const written = Object.keys(profiles).length;
    if (written) {
        updateSettings({ profiles: { ...getSettings().profiles, ...profiles } });
    }
    return written;
}

/**
 * Quick Image Gen 3.3+ advertises a quiet /qig that hands back the saved image path; before
 * that, or without it, the Image Generation extension's /imagine is the only way to a picture.
 */
function imageCommandFor(context, quoted) {
    const qig = context.SlashCommandParser?.commands?.qig;
    const quiet = Array.isArray(qig?.namedArgumentList) && qig.namedArgumentList.some(argument => argument?.name === 'quiet');
    return quiet ? `/qig quiet=true mode=direct ${quoted}` : `/imagine quiet=true gallery=false ${quoted}`;
}

/**
 * Forgets a timeline's passers-by, so the next refresh invents new ones. Their old posts keep
 * the name and avatar they were written under; only the cast that keeps coming back is dropped.
 */
export function clearStrangers(sessionId = ensureActiveSession().id) {
    const session = getSession(sessionId);
    if (!session) {
        throw new Error('That timeline session no longer exists.');
    }
    const cleared = session.strangers.length;
    if (cleared) {
        updateSession(sessionId, { strangers: [] });
    }
    return cleared;
}

export async function generatePostImage(prompt, signal) {
    const context = ctx();
    if (typeof context.executeSlashCommandsWithOptions !== 'function') {
        return '';
    }
    try {
        // The prompt is model output, so it is quoted and escaped: unquoted, its text could
        // parse as named flags (quiet=false gallery=true ...) instead of the image
        // description. quiet=true returns the path instead of posting into the open chat.
        const quoted = `"${inertText(prompt).replace(/[\\"]/g, '\\$&').replace(/\s+/g, ' ').trim()}"`;
        const result = await context.executeSlashCommandsWithOptions(
            imageCommandFor(context, quoted),
            { handleExecutionErrors: true, signal },
        );
        const pipe = typeof result?.pipe === 'string' ? result.pipe.trim() : '';
        // Anything that is not a path or URL is a status line ("QIG failed: ..."), not a picture.
        if (!/^(\/|https?:\/\/|data:image\/|blob:)/i.test(pipe)) {
            if (pipe) {
                console.warn('[Hopper] image generation returned no image:', pipe);
            }
            return '';
        }
        return pipe;
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
/**
 * The roleplay scene the user has open, for the accounts who are in it. Only read when the
 * user asks for it: this is chat text leaving the chat, and it goes wherever the timeline's
 * connection profile points.
 */
function currentScene(settings) {
    if (!settings.scene.enabled) {
        return null;
    }
    const context = ctx();
    const chat = Array.isArray(context.chat) ? context.chat : [];
    const lines = [];
    const names = new Set();
    let budget = SCENE_CHAR_BUDGET;
    for (const message of chat.slice(-SCENE_MESSAGE_LIMIT * 2).reverse()) {
        if (!message || message.is_system || typeof message.mes !== 'string' || !message.mes.trim()) {
            continue;
        }
        const who = message.name || (message.is_user ? context.name1 : context.name2) || 'Someone';
        const line = `${who}: ${message.mes.trim().replace(/\s+/g, ' ')}`;
        if (lines.length >= SCENE_MESSAGE_LIMIT || line.length > budget) {
            break;
        }
        budget -= line.length + 1;
        lines.unshift(line);
        // Who is in the scene is who speaks in it: a name the model can match to an account.
        if (!message.is_user) {
            names.add(who);
        }
    }
    // Without a name there is nobody the scene belongs to, and no way to say who may mention
    // it - so it is not worth sending the chat at all.
    if (!lines.length || !names.size) {
        return null;
    }
    return { names: [...names], lines };
}

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
    let profilesWritten = 0;
    if (needProfiles.length) {
        onProgress('Writing profiles...');
        const profiles = await generateProfilesFor(needProfiles, accounts, signal);
        profilesWritten = Object.keys(profiles).length;
        if (profilesWritten) {
            // Fresh read: the user may have edited profiles while generation was running.
            updateSettings({ profiles: { ...getSettings().profiles, ...profiles } });
        }
    }

    // Re-derive so freshly generated handles are the ones the prompt advertises.
    const freshAccounts = await currentAccounts(sessionId);
    const freshPersona = freshAccounts.find(account => account.kind === KIND_PERSONA) ?? persona;
    const current = getSettings();
    const currentSession = current.sessions[sessionId];
    if (!currentSession) {
        throw new Error('That timeline session no longer exists.');
    }
    const freshByKey = new Map(freshAccounts.map(account => [account.key, account]));
    const freshActive = active
        .map(account => freshByKey.get(account.key))
        .filter(account => account && (account.kind !== KIND_AMBIENT || currentSession.ambient));
    if (!freshActive.length && !currentSession.ambient) {
        throw new Error('Invite a character first, or let strangers join in.');
    }
    const activeKeys = new Set(freshActive.map(account => account.key));

    const scene = currentScene(current);
    const newId = () => ctx().uuidv4();
    const batch = {
        sessionId, feed, signal, onProgress, onPartial,
        accounts: freshAccounts, active: freshActive, persona: freshPersona, session: currentSession, settings: current,
        activeKeys, newId, topic, scene,
    };

    if (current.incremental && current.quotas.posts > 0) {
        const result = current.concurrency > 1
            ? await runParallelRefresh(batch)
            : await runIncrementalRefresh(batch);
        result.profilesWritten = profilesWritten;
        return result;
    }

    onProgress(topic ? `Writing posts about ${topic}...` : 'Writing posts...');
    const messages = buildRefreshMessages({
        accounts: freshAccounts,
        active: freshActive,
        persona: freshPersona,
        session: currentSession,
        posts: feed.posts,
        interactions: feed.interactions,
        settings: current,
        now: Date.now(),
        localTime: new Date().toLocaleString(),
        strangers: currentSession.ambient ? MAX_NEW_STRANGERS_PER_REFRESH : 0,
        // A topic refresh keeps the trending bar as it is; a plain one writes a fresh set.
        trends: !topic,
        topic,
        scene,
    });
    const parsed = await generateBatch(messages, current.maxTokens, batch, { throwOnFailure: true });
    const result = materializeRefresh(parsed, {
        accounts: freshAccounts,
        // The prompt asks for active accounts only; this enforces it locally, so a
        // malformed batch cannot act through an invited-but-deactivated character.
        allowedActorKeys: [...activeKeys],
        allowedPostAuthorKeys: [...activeKeys],
        settings: current,
        posts: feed.posts,
        interactions: feed.interactions,
        newId,
        now: Date.now(),
        strangerLimit: currentSession.ambient ? MAX_NEW_STRANGERS_PER_REFRESH : 0,
        requiredTopic: topic,
        allowTrends: !topic,
    });
    await commitBatch(result, batch);
    updateSession(sessionId, { lastRefreshAt: Date.now() });
    result.profilesWritten = profilesWritten;
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
            if (!url) {
                result.warnings.push(`image: could not be drawn for @${post.authorSnapshot?.handle ?? 'someone'}, posted as text`);
            }
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

    try {
        onPartial(result);
    } catch (error) {
        console.error('[Hopper] refresh observer failed after commit', error);
    }
}

/**
 * One post per request: each turn names an author, takes exactly one post plus the
 * reactions to it, commits it and shows it, then moves on. More requests, but the first
 * post lands in seconds and the timeline fills in as it goes.
 */
/**
 * One small request: a single post by the given author, plus the reactions around it. Used by
 * both paces - one at a time, and several at once.
 */
async function runOneTurn(batch, { index, total, author, turnSettings, strangersLeft, pollsLeft, trends, liveAccounts, activeKeys, remaining }) {
    const { feed, persona, session, topic, scene } = batch;
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
        pollLimit: pollsLeft,
        scene,
        turn: { index, total, author, remaining },
        trends,
        topic,
    });
    return generateBatch(messages, turnSettings.maxTokens, { ...batch, active: liveAccounts.filter(account => activeKeys.has(account.key)) });
}

/**
 * Several small requests in flight at once, each writing one post, each shown the moment it
 * lands. Wall-clock is roughly one request rather than all of them, at the cost of sending the
 * context once per request. Turns in the same wave cannot see each other, so each is given its
 * own author and its own slice of the allowance, and only the first may bring in strangers,
 * a poll or the trending bar.
 */
async function runParallelRefresh(batch) {
    const { sessionId, feed, signal, onProgress, accounts, active, session, settings, activeKeys, topic, newId } = batch;
    const quotas = settings.quotas;
    const total = quotas.posts;
    const cast = active.filter(account => account.kind === KIND_CHARACTER);
    const width = cast.length ? Math.min(Math.max(1, settings.concurrency), total) : 1;
    const shares = {
        replies: shareQuota(quotas.replies, total),
        reposts: shareQuota(quotas.reposts, total),
        likes: shareQuota(quotas.likes, total),
    };
    const all = { posts: [], interactions: [], follows: [], strangers: [], trends: [], warnings: [] };
    let commits = Promise.resolve();
    let successfulTurns = 0;
    let firstTransportError = null;

    for (let start = 1; start <= total; start += width) {
        signal?.throwIfAborted();
        const wave = [];
        for (let index = start; index < start + width && index <= total; index += 1) {
            wave.push(index);
        }
        onProgress(wave.length > 1
            ? `Writing posts ${wave[0]}-${wave.at(-1)} of ${total} at once...`
            : `Post ${wave[0]} of ${total}...`);

        const jobs = wave.map(async (index) => {
            const remaining = { replies: shares.replies[index - 1], reposts: shares.reposts[index - 1], likes: shares.likes[index - 1] };
            const imageLimit = settings.images.enabled && index <= settings.images.perRefresh ? 1 : 0;
            const turnSettings = {
                ...settings,
                quotas: { posts: 1, ...remaining },
                images: { ...settings.images, perRefresh: imageLimit },
            };
            let parsed;
            try {
                parsed = await runOneTurn(batch, {
                    index,
                    total,
                    author: cast.length ? cast[(index - 1) % cast.length] : null,
                    turnSettings,
                    // Only the opening turn may introduce anyone or set the bar; the rest would multiply them.
                    strangersLeft: index === 1 && session.ambient ? MAX_NEW_STRANGERS_PER_REFRESH : 0,
                    pollsLeft: index === 1 ? MAX_POLLS_PER_REFRESH : 0,
                    trends: index === 1 && !topic,
                    liveAccounts: accounts,
                    activeKeys,
                    remaining,
                });
            } catch (error) {
                if (signal?.aborted) {
                    throw error;
                }
                console.warn(`[Hopper] post ${index} of ${total} failed`, error);
                firstTransportError ??= error;
                all.warnings.push(`turn ${index}: ${error.message || 'request failed'}`);
                return;
            }
            if (!parsed) {
                all.warnings.push(`turn ${index}: nothing usable came back, skipped`);
                return;
            }
            successfulTurns += 1;
            const commit = commits.then(async () => {
                const liveAccounts = await currentAccounts(sessionId);
                const allowedPostAuthorKeys = authorKeysForTurn(cast.length ? cast[(index - 1) % cast.length] : null, liveAccounts, activeKeys);
                const result = materializeRefresh(parsed, {
                    accounts: liveAccounts,
                    allowedActorKeys: [...activeKeys],
                    allowedPostAuthorKeys,
                    allowNewStrangerPosts: !cast.length,
                    settings: turnSettings,
                    posts: feed.posts,
                    interactions: feed.interactions,
                    newId,
                    now: Date.now(),
                    strangerLimit: index === 1 && session.ambient ? MAX_NEW_STRANGERS_PER_REFRESH : 0,
                    strangerPostLimit: index === 1 ? 1 : 0,
                    pollLimit: index === 1 ? MAX_POLLS_PER_REFRESH : 0,
                    imageLimit,
                    requiredTopic: topic,
                    allowTrends: index === 1 && !topic,
                });
                await commitBatch(result, batch);
                for (const stranger of result.strangers) {
                    activeKeys.add(`${KIND_AMBIENT}:${stranger.id}`);
                }
                for (const key of ['posts', 'interactions', 'follows', 'strangers', 'trends', 'warnings']) {
                    all[key].push(...result[key]);
                }
            });
            commits = commit;
            await commit;
        });
        await Promise.all(jobs);
    }

    if (!successfulTurns && firstTransportError) {
        throw firstTransportError;
    }
    if (all.strangers.length) {
        // Anyone new joins the cast for the next refresh.
        await currentAccounts(sessionId);
    }
    if (successfulTurns) {
        updateSession(sessionId, { lastRefreshAt: Date.now() });
    }
    return all;
}

function authorKeysForTurn(author, accounts, activeKeys) {
    return author
        ? [author.key]
        : accounts.filter(account => account.kind === KIND_AMBIENT && activeKeys.has(account.key)).map(account => account.key);
}

async function runIncrementalRefresh(batch) {
    const { sessionId, feed, signal, onProgress, accounts, active, persona, session, settings, activeKeys, newId, topic, scene } = batch;
    const quotas = settings.quotas;
    const total = quotas.posts;
    const remaining = { replies: quotas.replies, reposts: quotas.reposts, likes: quotas.likes };
    let strangersLeft = session.ambient ? MAX_NEW_STRANGERS_PER_REFRESH : 0;
    let pollsLeft = MAX_POLLS_PER_REFRESH;
    let imagesLeft = settings.images.enabled ? settings.images.perRefresh : 0;
    let strangerPostsLeft = 1;
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
        const turnSettings = {
            ...settings,
            quotas: { posts: 1, replies: remaining.replies, reposts: remaining.reposts, likes: remaining.likes },
            images: { ...settings.images, perRefresh: Math.min(1, imagesLeft) },
        };
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
            pollLimit: pollsLeft,
            scene,
            turn: { index, total, author, remaining },
            // One set of made-up trends per refresh is plenty; the first turn writes them, and a topic refresh keeps the bar.
            trends: index === 1 && !topic,
            topic,
        });
        const parsed = await generateBatch(messages, settings.maxTokens, { ...batch, active: liveAccounts.filter(account => activeKeys.has(account.key)) });
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
            allowedPostAuthorKeys: authorKeysForTurn(author, liveAccounts, activeKeys),
            allowNewStrangerPosts: !author,
            settings: turnSettings,
            posts: feed.posts,
            interactions: feed.interactions,
            newId,
            now: Date.now(),
            strangerLimit: strangersLeft,
            strangerPostLimit: strangerPostsLeft,
            pollLimit: pollsLeft,
            imageLimit: imagesLeft,
            requiredTopic: topic,
            allowTrends: index === 1 && !topic,
        });
        const imagesUsed = result.posts.filter(post => post.image?.prompt).length;
        const pollsUsed = result.posts.filter(post => post.poll).length;
        const strangerPostsUsed = result.posts.filter(post => post.authorSnapshot?.kind === KIND_AMBIENT).length;
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
        strangersLeft = Math.max(0, strangersLeft - result.strangers.length);
        pollsLeft = Math.max(0, pollsLeft - pollsUsed);
        imagesLeft = Math.max(0, imagesLeft - imagesUsed);
        strangerPostsLeft = Math.max(0, strangerPostsLeft - strangerPostsUsed);
        if (result.strangers.length) {
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
