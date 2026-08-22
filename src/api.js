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
const PROFILE_MAX_TOKENS_BASE = 1024;

const REQUIRED_FUNCTIONS = [
    'getCharacters',
    'getThumbnailUrl',
    'getRequestHeaders',
    'saveSettingsDebounced',
    'setExtensionPrompt',
    'generateRaw',
];

export function assertCapabilities() {
    const context = ctx();
    const missing = REQUIRED_FUNCTIONS.filter(name => typeof context?.[name] !== 'function');
    for (const name of ['APP_READY', 'CHAT_CHANGED']) {
        if (!context?.eventTypes?.[name]) {
            missing.push(`eventTypes.${name}`);
        }
    }
    if (missing.length) {
        throw new Error(`Unsupported SillyBunny context; missing ${missing.join(', ')}`);
    }
    return context;
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

export function getPersona() {
    const context = ctx();
    const entityId = context.userAvatar;
    if (!entityId) {
        return null;
    }
    return {
        entityId,
        name: context.name1 || 'You',
        description: context.powerUserSettings?.persona_description ?? '',
    };
}

export async function currentAccounts() {
    const settings = getSettings();
    const characters = await ensureCharacters();
    return deriveAccounts({
        characters,
        invited: settings.invited,
        persona: getPersona(),
        ambient: settings.ambient,
        profiles: settings.profiles,
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

const EMPTY_FEED = { version: 1, posts: [], interactions: [] };

function normalizeFeed(raw) {
    if (!raw || typeof raw !== 'object') {
        return { ...EMPTY_FEED, posts: [], interactions: [] };
    }
    return {
        version: 1,
        posts: Array.isArray(raw.posts) ? raw.posts : [],
        interactions: Array.isArray(raw.interactions) ? raw.interactions : [],
    };
}

/**
 * The feed lives in the user files directory, not in extension settings. Both
 * extensionSettings and accountStorage serialise into settings.json, and every write there
 * re-serialises the whole file and copies it into a 50-deep backup rotation.
 */
export async function loadFeed() {
    const settings = getSettings();
    const path = settings.shards[0];
    if (!path) {
        return normalizeFeed(null);
    }
    try {
        const response = await fetch(`${path}?t=${Date.now()}`, { cache: 'no-store' });
        if (!response.ok) {
            return normalizeFeed(null);
        }
        return normalizeFeed(await response.json());
    } catch (error) {
        console.error('[TwitterLike] could not read the feed file', error);
        return normalizeFeed(null);
    }
}

function toBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
}

export async function writeFeed(feed) {
    const context = ctx();
    const body = JSON.stringify({ version: 1, posts: feed.posts, interactions: feed.interactions });
    const response = await fetch('/api/files/upload', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({ name: FEED_FILE, data: toBase64(body) }),
    });
    if (!response.ok) {
        throw new Error(`Could not save the feed (${response.status})`);
    }
    const { path } = await response.json();
    const settings = getSettings();
    if (settings.shards[0] !== path) {
        updateSettings({ shards: [path] });
    }
    return path;
}

/** Attaches a picture the user picked from their device to a post they are writing. */
export async function uploadImage(file) {
    const context = ctx();
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
    const { path } = await response.json();
    return path;
}

let pendingFeed = null;
let saveTimer = 0;

/** Liking three posts in a row should be one write, not three. */
export function saveFeedDebounced(feed, delay = 1200) {
    pendingFeed = feed;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        const snapshot = pendingFeed;
        pendingFeed = null;
        if (snapshot) {
            writeFeed(snapshot).catch(error => console.error('[TwitterLike] feed save failed', error));
        }
    }, delay);
}

export async function flushFeed() {
    clearTimeout(saveTimer);
    const snapshot = pendingFeed;
    pendingFeed = null;
    if (snapshot) {
        await writeFeed(snapshot);
    }
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
        console.warn('[TwitterLike] profile generation returned unusable JSON', error);
        return {};
    }
}

export async function generatePostImage(prompt) {
    const context = ctx();
    if (typeof context.executeSlashCommandsWithOptions !== 'function') {
        return '';
    }
    try {
        // quiet=true returns the URL instead of posting the image into the open chat.
        const result = await context.executeSlashCommandsWithOptions(
            `/imagine quiet=true gallery=false ${prompt.replace(/\|/g, ' ')}`,
            { handleExecutionErrors: true },
        );
        return typeof result?.pipe === 'string' ? result.pipe : '';
    } catch (error) {
        console.warn('[TwitterLike] image generation failed, publishing text only', error);
        return '';
    }
}

/**
 * One refresh: pick the cast, give anyone new a profile, ask for a batch of activity, then
 * re-check every quota locally before storing anything. The model is never trusted to have
 * obeyed the prompt.
 */
export async function runRefresh({ feed, signal, onProgress = () => {} } = {}) {
    const settings = getSettings();
    const accounts = await currentAccounts();
    const persona = accounts.find(account => account.kind === KIND_PERSONA) ?? null;

    const active = selectParticipants(accounts, settings, {
        posts: feed.posts,
        interactions: feed.interactions,
    });
    if (!active.length) {
        throw new Error('Invite a character first, or turn on the ambient accounts.');
    }

    // Only the selected cast gets a profile, so an install with 200 characters does not
    // send 200 cards on the first refresh.
    const needProfiles = active.filter(account => account.kind === KIND_CHARACTER && !account.hasProfile);
    if (needProfiles.length) {
        onProgress('Writing profiles...');
        const profiles = await generateProfilesFor(needProfiles, accounts, signal);
        if (Object.keys(profiles).length) {
            updateSettings({ profiles: { ...settings.profiles, ...profiles } });
        }
    }

    // Re-derive so freshly generated handles are the ones the prompt advertises.
    const freshAccounts = await currentAccounts();
    const activeKeys = new Set(active.map(account => account.key));
    const freshActive = freshAccounts.filter(account => activeKeys.has(account.key));
    const freshPersona = freshAccounts.find(account => account.kind === KIND_PERSONA) ?? persona;
    const current = getSettings();

    onProgress('Writing posts...');
    const messages = buildRefreshMessages({
        accounts: freshAccounts,
        active: freshActive,
        persona: freshPersona,
        posts: feed.posts,
        interactions: feed.interactions,
        settings: current,
        now: Date.now(),
        localTime: new Date().toLocaleString(),
    });

    let parsed = null;
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const attemptMessages = attempt === 0
            ? messages
            : [...messages, { role: 'user', content: buildCorrectionMessage(lastError, freshActive.map(a => a.handle)) }];
        const raw = await runGeneration(attemptMessages, REFRESH_MAX_TOKENS, signal);
        try {
            parsed = parseRefreshResponse(raw);
            break;
        } catch (error) {
            lastError = error.message;
            if (attempt === 1) {
                throw new Error(`The model did not return usable JSON (${error.message}).`);
            }
            onProgress('That came back malformed, asking again...');
        }
    }

    const result = materializeRefresh(parsed, {
        accounts: freshAccounts,
        settings: current,
        posts: feed.posts,
        interactions: feed.interactions,
        newId: () => ctx().uuidv4(),
        now: Date.now(),
    });

    if (current.images.enabled) {
        const withPrompts = result.posts.filter(post => post.image?.prompt);
        for (const [index, post] of withPrompts.entries()) {
            onProgress(`Drawing image ${index + 1} of ${withPrompts.length}...`);
            const url = await generatePostImage(post.image.prompt);
            // A failed image publishes a clean text-only post rather than exposing the prompt.
            post.image = url ? { url, prompt: post.image.prompt } : null;
        }
    }

    if (result.follows.length) {
        const follows = { ...current.follows };
        for (const { actorKey, targetKey } of result.follows) {
            follows[actorKey] = [...new Set([...(follows[actorKey] ?? []), targetKey])];
        }
        updateSettings({ follows });
    }

    feed.posts.push(...result.posts);
    feed.interactions.push(...result.interactions);
    updateSettings({ lastRefreshAt: Date.now() });
    await writeFeed(feed);

    return result;
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
export async function applyCarryover(feed) {
    const settings = getSettings();
    if (!settings.carry.enabled) {
        clearCarryover();
        return '';
    }

    const accounts = await currentAccounts();
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
        clearCarryover();
        return '';
    }
    context.setExtensionPrompt(
        EXT_PROMPT_KEY, block, EXTENSION_PROMPT_TYPE_IN_CHAT, settings.carry.depth, false, EXTENSION_PROMPT_ROLE_SYSTEM,
    );
    return block;
}
