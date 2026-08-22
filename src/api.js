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
        return { ...EMPTY_FEED };
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
export async function loadFeed() {
    const path = getSettings().shards[0];
    if (!path) {
        return { ...EMPTY_FEED };
    }
    try {
        const response = await fetch(`${path}?t=${Date.now()}`, { cache: 'no-store' });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const raw = await response.json();
        if (!isObj(raw) || !Array.isArray(raw.posts) || !Array.isArray(raw.interactions)) {
            throw new Error('the file does not contain a timeline');
        }
        return normalizeFeed(raw);
    } catch (error) {
        throw new Error(`The saved timeline could not be read (${error.message}). Try again, or reset the timeline to start over.`);
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
    const { path } = await response.json();
    return path;
}

let pendingFeed = null;
let saveTimer = 0;
let saveChain = Promise.resolve();

function snapshotFeed(feed) {
    return { version: 1, posts: [...feed.posts], interactions: [...feed.interactions] };
}

/**
 * One upload at a time, so an older write can never finish after a newer one. A failed
 * upload keeps its snapshot queued (unless something newer arrived) so flushFeed can
 * retry it - data is only dropped from the queue once it is durable.
 */
function enqueueSave() {
    clearTimeout(saveTimer);
    const snapshot = pendingFeed;
    pendingFeed = null;
    if (!snapshot) {
        return saveChain;
    }
    const attempt = saveChain.then(() => writeFeed(snapshot));
    saveChain = attempt.then(() => {}, error => {
        console.error('[Twitlike] feed save failed', error);
        if (!pendingFeed) {
            pendingFeed = snapshot;
        }
    });
    return attempt;
}

/** Liking three posts in a row should be one write, not three. */
export function saveFeedDebounced(feed, delay = 1200) {
    pendingFeed = snapshotFeed(feed);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { enqueueSave().catch(() => {}); }, delay);
}

/** Waits out any in-flight write, then writes whatever is still unsaved. */
export async function flushFeed() {
    return enqueueSave();
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
        console.warn('[Twitlike] profile generation returned unusable JSON', error);
        return {};
    }
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
        console.warn('[Twitlike] image generation failed, publishing text only', error);
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
            // Fresh read: the user may have edited profiles while generation was running.
            updateSettings({ profiles: { ...getSettings().profiles, ...profiles } });
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
        // The prompt asks for active accounts only; this enforces it locally, so a
        // malformed batch cannot act through an invited-but-deactivated character.
        allowedActorKeys: [...activeKeys],
        settings: current,
        posts: feed.posts,
        interactions: feed.interactions,
        newId: () => ctx().uuidv4(),
        now: Date.now(),
    });

    if (current.images.enabled) {
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
    await writeFeed(candidate);

    feed.posts.push(...result.posts);
    feed.interactions.push(...result.interactions);

    if (result.follows.length) {
        // Merge into the freshest settings so a follow made manually while the model was
        // thinking is not overwritten by this refresh's snapshot.
        const follows = { ...getSettings().follows };
        for (const { actorKey, targetKey } of result.follows) {
            follows[actorKey] = [...new Set([...(follows[actorKey] ?? []), targetKey])];
        }
        updateSettings({ follows });
    }
    updateSettings({ lastRefreshAt: Date.now() });

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
