// Pure logic: no host calls, no DOM. Everything here is unit-testable with plain objects.

export const SETTINGS_KEY = 'SillyBunny-TwitterLike';
export const EXT_PROMPT_KEY = 'SillyBunny-TwitterLike';
export const BODY_CLASS = 'sbtw';

export const KIND_PERSONA = 'persona';
export const KIND_CHARACTER = 'character';
export const KIND_AMBIENT = 'ambient';

export const RECENT_WINDOW_HOURS = 48;
export const MAX_TIMELINE_POSTS = 100;
export const MAX_REPLIES_PER_POST = 12;
export const POST_MAX_CHARS = 4000;
export const REPLY_MAX_CHARS = 2000;

/**
 * Ambient filler accounts. They have no character card, so they are defined entirely here.
 * They exist so a timeline with two invited characters does not read as an empty room.
 */
export const AMBIENT_ACCOUNTS = Object.freeze([
    { slug: 'signalloss', name: 'Signal Loss', handle: 'signalloss', bio: 'Posting through it.' },
    { slug: 'kettlelogic', name: 'Kettle Logic', handle: 'kettlelogic', bio: 'Arguing in good faith, allegedly.' },
    { slug: 'nocturneadmin', name: 'Nocturne Admin', handle: 'nocturneadmin', bio: 'Runs the night shift. Do not @ me before noon.' },
    { slug: 'paperlantern', name: 'Paper Lantern', handle: 'paperlantern', bio: 'Soft takes only.' },
    { slug: 'staticgarden', name: 'Static Garden', handle: 'staticgarden', bio: 'Photographs of nothing, mostly.' },
    { slug: 'wrongbus', name: 'Wrong Bus', handle: 'wrongbus', bio: 'Commuting, spiritually.' },
]);

export const DEFAULT_TONE = [
    '- Everyone on this timeline is an adult. In-character drama, flirtation, gossip, rudeness and explicit references are allowed where they fit the accounts involved.',
    "- Accounts post like real people online: funny, messy, indirect, petty, affectionate, dramatic, vulgar or casual. Which of those fits, and how much, comes from that account's own description and personality, not a default cheerful voice.",
    '- Before writing for an account, ground yourself in its stated traits. Let sentence length, punctuation, capitalisation and emoji use vary accordingly. A withdrawn or hostile character should not sound like an enthusiastic extrovert.',
    '- Characters may be rude to each other when it fits their personalities and history: petty, sarcastic, jealous, confrontational, reviving old grievances. This is permission, not a quota. Do not force conflict into every refresh.',
    '- Where it fits, have accounts react to, quote, subtweet or argue with each other\'s posts from this same batch rather than posting in isolation.',
    '- Ambient accounts are not characters. They are ordinary strangers who may follow, like, reply, repost, gossip or wander into public drama.',
    '- Standard Unicode emoji are fine when they suit the voice. Not every post needs one.',
].join('\n');

export const DEFAULT_IMAGE_INSTRUCTIONS = [
    'Either a social-media-ready image of the author, or an in-character meme they would plausibly post.',
    'For character images mention build, clothing, visible appearance, pose, expression, setting, lighting and composition.',
    'For memes mention the format, the visual gag, and any short readable caption.',
].join(' ');

export const DEFAULTS = Object.freeze({
    version: 1,
    invited: [],
    ambient: false,
    profileId: '',
    quotas: { posts: 8, replies: 12, reposts: 4, likes: 18 },
    active: { mode: 'range', min: 2, max: 5, count: 3 },
    images: { enabled: false, perRefresh: 3, instructions: '' },
    polls: true,
    tone: '',
    carry: { enabled: false, hours: 48, items: 8, depth: 1 },
    catchUpHours: 0,
    lastRefreshAt: 0,
    profiles: {},
    follows: {},
    shards: [],
});

const ACTIVE_MODES = new Set(['range', 'exact', 'all']);

function clampInt(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, Math.trunc(number)));
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringArray(value) {
    return Array.isArray(value) ? value.filter(item => typeof item === 'string' && item.length > 0) : [];
}

/**
 * Total: never throws, coerces anything into a usable settings object. A half-written or
 * hand-edited settings blob should degrade to defaults, not break the extension at boot.
 */
export function normalizeSettings(raw) {
    const source = isPlainObject(raw) ? raw : {};
    const quotas = isPlainObject(source.quotas) ? source.quotas : {};
    const active = isPlainObject(source.active) ? source.active : {};
    const images = isPlainObject(source.images) ? source.images : {};
    const carry = isPlainObject(source.carry) ? source.carry : {};

    const min = clampInt(active.min, 1, 100, DEFAULTS.active.min);
    const max = clampInt(active.max, 1, 100, DEFAULTS.active.max);

    const profiles = {};
    if (isPlainObject(source.profiles)) {
        for (const [key, value] of Object.entries(source.profiles)) {
            if (!isPlainObject(value)) {
                continue;
            }
            profiles[key] = {
                name: typeof value.name === 'string' ? value.name : '',
                handle: typeof value.handle === 'string' ? value.handle : '',
                bio: typeof value.bio === 'string' ? value.bio : '',
                location: typeof value.location === 'string' ? value.location : '',
            };
        }
    }

    const follows = {};
    if (isPlainObject(source.follows)) {
        for (const [key, value] of Object.entries(source.follows)) {
            const list = stringArray(value);
            if (list.length) {
                follows[key] = [...new Set(list)];
            }
        }
    }

    return {
        version: 1,
        invited: [...new Set(stringArray(source.invited))],
        ambient: source.ambient === true,
        profileId: typeof source.profileId === 'string' ? source.profileId : '',
        quotas: {
            posts: clampInt(quotas.posts, 0, 100, DEFAULTS.quotas.posts),
            replies: clampInt(quotas.replies, 0, 200, DEFAULTS.quotas.replies),
            reposts: clampInt(quotas.reposts, 0, 100, DEFAULTS.quotas.reposts),
            likes: clampInt(quotas.likes, 0, 500, DEFAULTS.quotas.likes),
        },
        active: {
            mode: ACTIVE_MODES.has(active.mode) ? active.mode : DEFAULTS.active.mode,
            min: Math.min(min, max),
            max: Math.max(min, max),
            count: clampInt(active.count, 1, 100, DEFAULTS.active.count),
        },
        images: {
            enabled: images.enabled === true,
            perRefresh: clampInt(images.perRefresh, 0, 50, DEFAULTS.images.perRefresh),
            instructions: typeof images.instructions === 'string' ? images.instructions.slice(0, 4000) : '',
        },
        polls: source.polls !== false,
        tone: typeof source.tone === 'string' ? source.tone.slice(0, 8000) : '',
        carry: {
            enabled: carry.enabled === true,
            hours: clampInt(carry.hours, 1, 720, DEFAULTS.carry.hours),
            items: clampInt(carry.items, 1, 50, DEFAULTS.carry.items),
            depth: clampInt(carry.depth, 0, 100, DEFAULTS.carry.depth),
        },
        catchUpHours: clampInt(source.catchUpHours, 0, 720, DEFAULTS.catchUpHours),
        lastRefreshAt: clampInt(source.lastRefreshAt, 0, Number.MAX_SAFE_INTEGER, 0),
        profiles,
        follows,
        shards: stringArray(source.shards),
    };
}

export function toneText(settings) {
    const custom = typeof settings?.tone === 'string' ? settings.tone.trim() : '';
    return custom || DEFAULT_TONE;
}

export function imageInstructions(settings) {
    const custom = typeof settings?.images?.instructions === 'string' ? settings.images.instructions.trim() : '';
    return custom || DEFAULT_IMAGE_INSTRUCTIONS;
}

// --- accounts -------------------------------------------------------------

export function accountKey(kind, entityId) {
    return `${kind}:${entityId}`;
}

export function handleFromName(name, taken = new Set()) {
    const base = String(name ?? '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 20) || 'account';
    if (!taken.has(base)) {
        return base;
    }
    // Suffix inside the 20-character mention grammar: a 20-char base + "2" would not match.
    for (let suffix = 2; suffix < 1000; suffix += 1) {
        const candidate = `${base.slice(0, 20 - String(suffix).length)}${suffix}`;
        if (!taken.has(candidate)) {
            return candidate;
        }
    }
    return `${base.slice(0, 18)}_x`;
}

/**
 * Builds the account list for a refresh or a render. `characters` is the host's character
 * array, which is empty until getCharacters() has been awaited - the caller owns that.
 */
export function deriveAccounts({ characters = [], invited = [], persona = null, ambient = false, profiles = {} } = {}) {
    const accounts = [];
    const taken = new Set();
    const invitedSet = new Set(invited);

    const push = (draft) => {
        const stored = profiles[draft.key] ?? {};
        // Stored handles run through the same allocator as generated ones: "Echo" and a
        // later stored "echo" cannot collide, and an invalid handle cannot bypass checks.
        const handle = handleFromName((stored.handle || '').trim() || draft.name, taken);
        taken.add(handle);
        accounts.push({
            key: draft.key,
            kind: draft.kind,
            entityId: draft.entityId,
            name: (stored.name || '').trim() || draft.name,
            handle,
            bio: stored.bio ?? draft.bio ?? '',
            location: stored.location ?? '',
            hasProfile: Boolean(stored.handle),
            description: draft.description ?? '',
            personality: draft.personality ?? '',
            scenario: draft.scenario ?? '',
        });
    };

    if (persona?.entityId) {
        push({
            key: accountKey(KIND_PERSONA, persona.entityId),
            kind: KIND_PERSONA,
            entityId: persona.entityId,
            name: persona.name || 'You',
            description: persona.description ?? '',
        });
    }

    for (const character of characters) {
        const entityId = character?.avatar;
        if (!entityId || !invitedSet.has(entityId)) {
            continue;
        }
        const data = isPlainObject(character.data) ? character.data : {};
        push({
            key: accountKey(KIND_CHARACTER, entityId),
            kind: KIND_CHARACTER,
            entityId,
            name: character.name || data.name || 'Character',
            description: data.description ?? character.description ?? '',
            personality: data.personality ?? character.personality ?? '',
            scenario: data.scenario ?? character.scenario ?? '',
        });
    }

    if (ambient) {
        for (const item of AMBIENT_ACCOUNTS) {
            push({
                key: accountKey(KIND_AMBIENT, item.slug),
                kind: KIND_AMBIENT,
                entityId: item.slug,
                name: item.name,
                bio: item.bio,
            });
        }
    }

    return accounts;
}

export function snapshotOf(account) {
    return {
        key: account.key,
        kind: account.kind,
        handle: account.handle,
        name: account.name,
    };
}

export function handleIndex(accounts) {
    const map = new Map();
    for (const account of accounts) {
        map.set(account.handle.toLowerCase(), account);
    }
    return map;
}

// --- participant selection ------------------------------------------------

function lastActivityAt(key, posts, interactions) {
    let latest = 0;
    for (const post of posts) {
        if (post.authorKey === key && post.createdAt > latest) {
            latest = post.createdAt;
        }
    }
    for (const interaction of interactions) {
        if (interaction.actorKey === key && interaction.createdAt > latest) {
            latest = interaction.createdAt;
        }
    }
    return latest;
}

/**
 * Picks who takes part in one refresh. Quiet accounts go first so the same two characters
 * do not monopolise the timeline, and ambient accounts stay rare on purpose - they are
 * texture, and a feed full of strangers is not what anyone installed this for.
 */
export function selectParticipants(accounts, settings, { posts = [], interactions = [], random = Math.random } = {}) {
    const characters = accounts.filter(account => account.kind === KIND_CHARACTER);
    const ambient = accounts.filter(account => account.kind === KIND_AMBIENT);
    if (!characters.length && !ambient.length) {
        return [];
    }

    const { mode, min, max, count } = settings.active;
    let wanted;
    if (mode === 'all') {
        wanted = characters.length + ambient.length;
    } else if (mode === 'exact') {
        wanted = count;
    } else {
        wanted = min + Math.floor(random() * (max - min + 1));
    }
    wanted = Math.max(1, Math.min(wanted, characters.length + ambient.length));

    // An ambient-only install has no characters to rank - the strangers ARE the cast.
    if (!characters.length) {
        if (mode === 'all') {
            return [...ambient];
        }
        const shuffled = [...ambient].sort(() => random() - 0.5);
        return shuffled.slice(0, Math.min(wanted, ambient.length));
    }

    const ranked = characters
        .map(account => ({ account, seen: lastActivityAt(account.key, posts, interactions), jitter: random() }))
        .sort((a, b) => (a.seen - b.seen) || (a.jitter - b.jitter))
        .map(entry => entry.account);

    const chosen = ranked.slice(0, wanted);

    // One ambient account, one time in four, and never as the entire cast.
    const roomLeft = wanted - chosen.length;
    const wantAmbient = ambient.length > 0 && (mode === 'all' || (chosen.length > 0 && random() < 0.25));
    if (wantAmbient) {
        const pick = ambient[Math.floor(random() * ambient.length)];
        if (mode === 'all') {
            chosen.push(...ambient);
        } else if (roomLeft > 0) {
            chosen.push(pick);
        } else if (chosen.length > 1) {
            chosen[chosen.length - 1] = pick;
        }
    }

    return chosen;
}

// --- prompt ---------------------------------------------------------------

export function buildSystemPrompt(settings) {
    return [
        'You write a fake social media timeline for an in-app parody site. Every account belongs to the user\'s own installation; nothing here is posted anywhere real.',
        '',
        '# Rules',
        '- Structured actions are limited to posts, polls, follows, likes, reposts, replies and poll votes.',
        '- Use only the accounts listed under "Active Accounts" by @handle. Never invent an account.',
        '- The user persona is controlled exclusively by the user. Never write posts, replies, likes, reposts, votes or follows as a persona. A persona may only be mentioned or targeted by other accounts.',
        '- Interactions may target posts included in this prompt, or posts you create in this response.',
        '- For each interaction set either targetTempId or targetPostId, and set the other to null.',
        '- To answer an existing comment, create a reply for its post and set parentInteractionId to that comment\'s exact replyId. Otherwise set parentInteractionId to null.',
        '- pollOptionIndex is a zero-based integer for votes and null for everything else.',
        '- Never make an account interact twice with the same post, and never let an account reply to its own comment.',
        '- Never reuse the same text for two posts or replies. Do not copy a post\'s text into a reply.',
        '- An exact @handle in text tags that account. Preserve @handles exactly.',
        '- Return JSON only. No prose outside the JSON object.',
        '',
        '# Voice',
        toneText(settings),
    ].join('\n');
}

function characterBlock(account) {
    const lines = [`<account name="${account.name}" handle="@${account.handle}" kind="${account.kind}">`];
    if (account.description) {
        lines.push(`Description: ${account.description}`);
    }
    if (account.personality) {
        lines.push(`Personality: ${account.personality}`);
    }
    if (account.scenario) {
        lines.push(`Scenario: ${account.scenario}`);
    }
    if (account.bio) {
        lines.push(`Profile bio: ${account.bio}`);
    }
    lines.push('</account>');
    return lines.join('\n');
}

/**
 * The output token cap never bounded input: 100 maximum posts with a dozen long replies
 * each is megabytes of prompt. Newest entries win; the oldest fall off first.
 */
const TIMELINE_CHAR_BUDGET = 48000;

export function formatTimeline(posts, interactions, accounts, { now = Date.now(), windowHours = RECENT_WINDOW_HOURS } = {}) {
    const byKey = new Map(accounts.map(account => [account.key, account]));
    const label = (key, snapshot) => {
        const account = byKey.get(key);
        return `@${account?.handle ?? snapshot?.handle ?? 'unknown'}`;
    };
    const cutoff = now - windowHours * 3600 * 1000;
    const recent = posts
        .filter(post => post.createdAt >= cutoff)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, MAX_TIMELINE_POSTS);
    if (!recent.length) {
        return 'No recent activity.';
    }

    const repliesByPost = new Map();
    const countsByPost = new Map();
    for (const interaction of interactions) {
        const counts = countsByPost.get(interaction.postId) ?? { like: 0, repost: 0 };
        if (interaction.type === 'like' || interaction.type === 'repost') {
            counts[interaction.type] += 1;
            countsByPost.set(interaction.postId, counts);
        }
        if (interaction.type === 'reply') {
            const list = repliesByPost.get(interaction.postId) ?? [];
            list.push(interaction);
            repliesByPost.set(interaction.postId, list);
        }
    }

    const blockOf = (post) => {
        const counts = countsByPost.get(post.id) ?? { like: 0, repost: 0 };
        const lines = [
            `postId=${post.id} ${label(post.authorKey, post.authorSnapshot)} likes=${counts.like} reposts=${counts.repost}`,
            inertText(post.body),
        ];
        if (post.poll) {
            const options = post.poll.options.map((option, index) => `${index}) ${option.text}`).join(' | ');
            lines.push(`poll: ${inertText(post.poll.question)} [${inertText(options)}]`);
        }
        const replies = (repliesByPost.get(post.id) ?? [])
            .sort((a, b) => a.createdAt - b.createdAt)
            .slice(-MAX_REPLIES_PER_POST);
        for (const reply of replies) {
            lines.push(`  replyId=${reply.id} ${label(reply.actorKey, reply.actorSnapshot)}: ${inertText(reply.content)}`);
        }
        return lines.join('\n');
    };

    // Newest first, so the budget drops the oldest history rather than the freshest.
    const blocks = [];
    let used = 0;
    for (const post of recent) {
        const block = blockOf(post);
        if (blocks.length && used + block.length > TIMELINE_CHAR_BUDGET) {
            break;
        }
        blocks.push(block);
        used += block.length + 1;
    }
    return blocks.reverse().join('\n\n').trim();
}

export function buildContextMessage({ accounts, active, persona, posts = [], interactions = [], settings, now = Date.now(), localTime = '' }) {
    const activeKeys = new Set(active.map(account => account.key));
    const roster = accounts
        .map((account) => {
            const role = account.kind === KIND_PERSONA
                ? 'reference-target-only'
                : (activeKeys.has(account.key) ? 'allowed-author-and-actor' : 'reference-target-only');
            return `- ${account.name} (@${account.handle}) kind=${account.kind} role=${role}`;
        })
        .join('\n');

    const sections = [
        '# Active Accounts',
        roster || 'No accounts.',
        '',
        `Current local time: ${localTime || new Date(now).toISOString()}`,
        '',
    ];

    if (persona) {
        sections.push('# User Persona', characterBlock(persona), '');
    }

    const activeCharacters = active.filter(account => account.kind === KIND_CHARACTER);
    sections.push(
        '# Character Profiles',
        activeCharacters.length ? activeCharacters.map(characterBlock).join('\n\n') : 'No character profiles.',
        '',
    );

    const activeAmbient = active.filter(account => account.kind === KIND_AMBIENT);
    if (activeAmbient.length) {
        sections.push('# Ambient Accounts', activeAmbient.map(characterBlock).join('\n\n'), '');
    }

    sections.push(
        '# Recent Timeline',
        'Replies to the persona are especially worth answering. Use a comment\'s replyId as parentInteractionId to answer it directly.',
        formatTimeline(posts, interactions, accounts, { now }),
        '',
        '# Quotas',
        `posts: at most ${settings.quotas.posts}`,
        `replies: at most ${settings.quotas.replies}`,
        `reposts: at most ${settings.quotas.reposts}`,
        `likes: at most ${settings.quotas.likes}`,
        'follows: optional, and sparing. Only when an account would naturally follow another after this activity.',
        settings.polls
            ? 'polls: optional. Use one when a question or set of choices genuinely fits the account, not as a quota.'
            : 'polls: disabled. Always set poll to null.',
        settings.images.enabled
            ? `image generation: at most ${settings.images.perRefresh} images this refresh. ${imageInstructions(settings)} imagePrompt must contain only the visual description, never the post text or instructions.`
            : 'image generation: disabled. Always set imagePrompt to null.',
    );

    return sections.join('\n');
}

const OUTPUT_SHAPE = {
    posts: [{
        tempId: 'local id used only inside this response',
        authorHandle: 'exact @handle of a non-persona account allowed to author',
        content: 'post text',
        poll: { question: 'optional poll question', options: ['first answer', 'second answer'] },
        imagePrompt: 'optional image prompt or null',
    }],
    interactions: [{
        actorHandle: 'exact @handle of a non-persona account allowed to act',
        targetTempId: 'tempId from posts, when targeting a post created in this response',
        targetPostId: 'existing postId, when targeting a post from the timeline above',
        parentInteractionId: 'existing replyId when answering a comment directly, otherwise null',
        type: 'like | repost | reply | vote',
        content: 'required for reply, null otherwise',
        pollOptionIndex: 1,
    }],
    follows: [{
        actorHandle: 'exact @handle of a non-persona account',
        targetHandle: 'exact @handle from Active Accounts',
    }],
};

export function buildFormatMessage() {
    return ['# JSON Output Format', JSON.stringify(OUTPUT_SHAPE, null, 2)].join('\n');
}

export function buildRefreshMessages({ accounts, active, persona, posts, interactions, settings, now, localTime }) {
    return [
        { role: 'system', content: buildSystemPrompt(settings) },
        { role: 'user', content: buildContextMessage({ accounts, active, persona, posts, interactions, settings, now, localTime }) },
        { role: 'user', content: buildFormatMessage() },
    ];
}

export function buildCorrectionMessage(reason, allowedHandles) {
    return [
        'Your previous response could not be used.',
        `Reason: ${reason}.`,
        `Regenerate the complete JSON object now. Authors and actors must use only these handles: ${allowedHandles.map(handle => `@${handle}`).join(', ')}.`,
        'Do not invent, rename or omit a handle. Return JSON only.',
    ].join('\n');
}

// --- profile generation ---------------------------------------------------

export function buildProfileMessages(accounts) {
    const blocks = accounts.map(account => [
        `<profile_target entityId="${account.entityId}" name="${account.name}">`,
        account.description ? `Description: ${account.description}` : '',
        account.personality ? `Personality: ${account.personality}` : '',
        account.scenario ? `Scenario: ${account.scenario}` : '',
        '</profile_target>',
    ].filter(Boolean).join('\n')).join('\n\n');

    return [
        {
            role: 'system',
            content: [
                'You set up fake social media profiles for existing roleplay characters.',
                'Everyone on the platform is an adult.',
                'Create concise profile metadata only. Do not write posts, replies or timeline content.',
                "Use each character's personality, setting and appearance so the profile feels in character.",
                'Return JSON only. No prose outside the JSON object.',
            ].join('\n'),
        },
        {
            role: 'user',
            content: [
                '# Characters Needing Profiles',
                blocks,
                '',
                '# JSON Output Format',
                JSON.stringify({
                    profiles: [{
                        entityId: 'exact entityId from profile_target',
                        name: 'display name for the social profile',
                        handle: 'short nickname without @, lowercase letters, numbers and underscores',
                        bio: 'short in-character social media bio',
                        location: 'short profile location, fictional or canonical',
                    }],
                }, null, 2),
            ].join('\n'),
        },
    ];
}

export function parseProfileResponse(raw, accounts, otherAccounts = []) {
    const data = parseJsonObject(raw);
    const byEntity = new Map(accounts.map(account => [account.entityId, account]));
    // An account's own derived handle must not block its generated one, or the first
    // profile ever written for "Seraphina" comes back as @seraphina2.
    const taken = new Set(otherAccounts.map(account => account.handle));
    const out = {};
    for (const entry of Array.isArray(data.profiles) ? data.profiles : []) {
        const account = byEntity.get(String(entry?.entityId ?? ''));
        if (!account) {
            continue;
        }
        const handle = handleFromName(entry?.handle || entry?.name || account.name, taken);
        taken.add(handle);
        out[account.key] = {
            name: String(entry?.name ?? account.name).slice(0, 60),
            handle,
            bio: String(entry?.bio ?? '').slice(0, 300),
            location: String(entry?.location ?? '').slice(0, 80),
        };
    }
    return out;
}

// --- response parsing -----------------------------------------------------

/**
 * Models fence JSON, prefix it with prose, or trail a stray token. Pull the outermost
 * object out rather than trusting the whole string to be valid on its own.
 */
export function parseJsonObject(raw) {
    const text = String(raw ?? '').trim();
    if (!text) {
        throw new Error('empty response');
    }
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidates = [];
    if (fenced) {
        candidates.push(fenced[1].trim());
    }
    candidates.push(text);
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
        candidates.push(text.slice(start, end + 1));
    }
    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate);
            if (isPlainObject(parsed)) {
                return parsed;
            }
        } catch {
            // try the next shape
        }
    }
    throw new Error('response was not JSON');
}

export function parseRefreshResponse(raw) {
    const data = parseJsonObject(raw);
    return {
        posts: Array.isArray(data.posts) ? data.posts : [],
        interactions: Array.isArray(data.interactions) ? data.interactions : [],
        follows: Array.isArray(data.follows) ? data.follows : [],
    };
}

function normalizeText(value) {
    return String(value ?? '').normalize('NFKC').trim().toLowerCase();
}

function cleanPoll(poll, enabled) {
    if (!enabled || !isPlainObject(poll)) {
        return null;
    }
    // Truncate first, then dedupe: two options differing only past the limit would
    // otherwise pass as distinct and be stored identical.
    const options = (Array.isArray(poll.options) ? poll.options : [])
        .map(option => String(typeof option === 'string' ? option : option?.text ?? '').trim().slice(0, 120))
        .filter(Boolean);
    const unique = [...new Set(options)].slice(0, 4);
    if (unique.length < 2) {
        return null;
    }
    return {
        question: String(poll.question ?? '').trim().slice(0, 200),
        options: unique.map((text, index) => ({ id: `option-${index}`, text })),
    };
}

/**
 * Feed text is model output. Wherever it meets the host's prompt machinery it must stay
 * inert data, so {{macro}} syntax is broken up with a zero-width space and can never be
 * expanded by generateRaw or the prompt builder.
 */
export function inertText(text) {
    return String(text ?? '').replace(/\{\{/g, '{\u200b{');
}

/**
 * Turns a parsed response into rows we are willing to store.
 *
 * The model is not trusted here: quotas are re-applied, persona-authored activity is
 * dropped, invented handles are dropped, duplicate likes and votes are collapsed, and
 * repeated text from the same account is discarded. Everything rejected is reported in
 * `warnings` rather than swallowed, so the UI can say the refresh was partly ignored.
 */
export function materializeRefresh(parsed, {
    accounts,
    allowedActorKeys = null,
    settings,
    posts: existingPosts = [],
    interactions: existingInteractions = [],
    newId,
    now = Date.now(),
} = {}) {
    const warnings = [];
    const byHandle = handleIndex(accounts);
    const actorKeys = allowedActorKeys ? new Set(allowedActorKeys) : null;
    const existingPostIds = new Set(existingPosts.map(post => post.id));
    const existingReplyIds = new Set(existingInteractions.filter(item => item.type === 'reply').map(item => item.id));
    const pollByPostId = new Map(existingPosts.filter(post => post.poll).map(post => [post.id, post.poll]));

    const seenPairs = new Set(existingInteractions.map(item => `${item.postId}|${item.actorKey}|${item.type}`));
    const seenText = new Set(existingPosts.map(post => `${post.authorKey}|${normalizeText(post.body)}`));
    for (const item of existingInteractions) {
        if (item.type === 'reply') {
            seenText.add(`${item.actorKey}|${normalizeText(item.content)}`);
        }
    }

    const resolveActor = (handle, what) => {
        const account = byHandle.get(String(handle ?? '').replace(/^@/, '').toLowerCase());
        if (!account) {
            warnings.push(`${what}: unknown handle @${handle}`);
            return null;
        }
        if (account.kind === KIND_PERSONA) {
            warnings.push(`${what}: dropped, the model wrote as your persona`);
            return null;
        }
        if (actorKeys && !actorKeys.has(account.key)) {
            warnings.push(`${what}: dropped, @${account.handle} is not active this refresh`);
            return null;
        }
        return account;
    };

    // Posts first, so interactions can target them by tempId.
    const outPosts = [];
    const tempIds = new Map();
    let imageBudget = settings.images.enabled ? settings.images.perRefresh : 0;

    for (const draft of parsed.posts) {
        if (outPosts.length >= settings.quotas.posts) {
            warnings.push('post quota reached, extra posts ignored');
            break;
        }
        const author = resolveActor(draft?.authorHandle, 'post');
        if (!author) {
            continue;
        }
        const body = String(draft?.content ?? '').trim().slice(0, POST_MAX_CHARS);
        if (!body) {
            continue;
        }
        const textKey = `${author.key}|${normalizeText(body)}`;
        if (seenText.has(textKey)) {
            warnings.push(`post: ${author.name} repeated itself, dropped`);
            continue;
        }
        seenText.add(textKey);

        let imagePrompt = null;
        if (imageBudget > 0 && typeof draft?.imagePrompt === 'string' && draft.imagePrompt.trim()) {
            imagePrompt = draft.imagePrompt.trim().slice(0, 2000);
            imageBudget -= 1;
        }

        const post = {
            id: newId(),
            authorKey: author.key,
            body,
            createdAt: now,
            image: imagePrompt ? { url: '', prompt: imagePrompt } : null,
            poll: cleanPoll(draft?.poll, settings.polls),
            authorSnapshot: snapshotOf(author),
        };
        if (draft?.tempId) {
            const tempKey = String(draft.tempId);
            // First post wins: a duplicate must not silently retarget interactions.
            if (tempIds.has(tempKey)) {
                warnings.push(`post: duplicate tempId "${tempKey}", later posts cannot be targeted by it`);
            } else {
                tempIds.set(tempKey, post.id);
            }
        }
        if (post.poll) {
            pollByPostId.set(post.id, post.poll);
        }
        outPosts.push(post);
    }

    const counts = { reply: 0, repost: 0, like: 0, vote: 0 };
    const limits = {
        reply: settings.quotas.replies,
        repost: settings.quotas.reposts,
        like: settings.quotas.likes,
        vote: settings.quotas.likes,
    };
    const outInteractions = [];

    for (const draft of parsed.interactions) {
        const type = String(draft?.type ?? '').toLowerCase();
        if (!Object.hasOwn(limits, type)) {
            warnings.push(`interaction: unknown type "${draft?.type}"`);
            continue;
        }
        if (counts[type] >= limits[type]) {
            continue;
        }
        const actor = resolveActor(draft?.actorHandle, 'interaction');
        if (!actor) {
            continue;
        }

        let postId = null;
        if (draft?.targetTempId && tempIds.has(String(draft.targetTempId))) {
            postId = tempIds.get(String(draft.targetTempId));
        } else if (draft?.targetPostId && existingPostIds.has(String(draft.targetPostId))) {
            postId = String(draft.targetPostId);
        }
        if (!postId) {
            warnings.push(`interaction: target not found for ${type} by @${actor.handle}`);
            continue;
        }

        const target = outPosts.find(post => post.id === postId) ?? existingPosts.find(post => post.id === postId);
        if (target && target.authorKey === actor.key && (type === 'like' || type === 'repost')) {
            continue;
        }

        const pairKey = `${postId}|${actor.key}|${type}`;
        if (type !== 'reply' && seenPairs.has(pairKey)) {
            continue;
        }

        let content = null;
        let parentInteractionId = null;
        let pollOptionIndex = null;

        if (type === 'reply') {
            content = String(draft?.content ?? '').trim().slice(0, REPLY_MAX_CHARS);
            if (!content) {
                continue;
            }
            const textKey = `${actor.key}|${normalizeText(content)}`;
            if (seenText.has(textKey)) {
                continue;
            }
            seenText.add(textKey);
            const parent = draft?.parentInteractionId ? String(draft.parentInteractionId) : '';
            if (parent && existingReplyIds.has(parent)) {
                const parentReply = existingInteractions.find(item => item.id === parent);
                // The parent must be a reply to THIS post; a cross-post parent would
                // invent a conversation that never happened.
                if (parentReply && parentReply.actorKey !== actor.key && parentReply.postId === postId) {
                    parentInteractionId = parent;
                }
            }
        } else if (type === 'vote') {
            const poll = pollByPostId.get(postId);
            const index = draft?.pollOptionIndex;
            // Strict integer: Number(null)/Number('') are 0, which would vote for the
            // first option on malformed input.
            if (!poll || !Number.isInteger(index) || index < 0 || index >= poll.options.length) {
                warnings.push(`vote: invalid option for post ${postId}`);
                continue;
            }
            pollOptionIndex = index;
        }

        seenPairs.add(pairKey);
        counts[type] += 1;
        outInteractions.push({
            id: newId(),
            postId,
            type,
            actorKey: actor.key,
            content,
            parentInteractionId,
            pollOptionIndex,
            createdAt: now,
            actorSnapshot: snapshotOf(actor),
        });
    }

    const followLimit = Math.max(12, accounts.length * 2);
    const outFollows = [];
    const seenFollowPairs = new Set();
    for (const draft of parsed.follows) {
        if (outFollows.length >= followLimit) {
            break;
        }
        const actor = resolveActor(draft?.actorHandle, 'follow');
        const target = byHandle.get(String(draft?.targetHandle ?? '').replace(/^@/, '').toLowerCase());
        if (!actor || !target || actor.key === target.key) {
            continue;
        }
        // Dedupe first: twelve copies of one follow must not eat the cap and starve
        // the unique follows behind them.
        const pair = `${actor.key}|${target.key}`;
        if (seenFollowPairs.has(pair)) {
            continue;
        }
        seenFollowPairs.add(pair);
        outFollows.push({ actorKey: actor.key, targetKey: target.key });
    }

    return { posts: outPosts, interactions: outInteractions, follows: outFollows, warnings };
}

// --- carryover ------------------------------------------------------------

export function digestLines(posts, interactions, accounts, { since = 0, limit = 8, keys = null } = {}) {
    const byKey = new Map(accounts.map(account => [account.key, account]));
    const nameOf = (key, snapshot) => byKey.get(key)?.name ?? snapshot?.name ?? 'Someone';
    const postById = new Map(posts.map(post => [post.id, post]));
    const wanted = keys ? new Set(keys) : null;
    const rows = [];

    for (const post of posts) {
        if (post.createdAt < since || (wanted && !wanted.has(post.authorKey))) {
            continue;
        }
        rows.push({ at: post.createdAt, text: `${nameOf(post.authorKey, post.authorSnapshot)} posted: ${inertText(post.body)}` });
    }

    for (const item of interactions) {
        if (item.createdAt < since || (wanted && !wanted.has(item.actorKey))) {
            continue;
        }
        const target = postById.get(item.postId);
        const targetName = target ? nameOf(target.authorKey, target.authorSnapshot) : 'a post';
        const actor = nameOf(item.actorKey, item.actorSnapshot);
        if (item.type === 'reply') {
            rows.push({ at: item.createdAt, text: `${actor} replied to ${targetName}: ${inertText(item.content)}` });
        } else if (item.type === 'repost') {
            rows.push({ at: item.createdAt, text: `${actor} reposted ${targetName}.` });
        } else if (item.type === 'like') {
            rows.push({ at: item.createdAt, text: `${actor} liked a post by ${targetName}.` });
        }
    }

    return rows
        .sort((a, b) => b.at - a.at)
        .slice(0, limit)
        .sort((a, b) => a.at - b.at)
        .map(row => row.text);
}

export function buildCarryoverBlock(lines) {
    if (!lines.length) {
        return '';
    }
    return ['[Recent Social Media Activity]', ...lines.map(line => `- ${line}`)].join('\n');
}

// --- misc -----------------------------------------------------------------

export function needsCatchUp(settings, now = Date.now()) {
    if (!settings.catchUpHours) {
        return false;
    }
    return now - settings.lastRefreshAt >= settings.catchUpHours * 3600 * 1000;
}
