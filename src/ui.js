// Every DOM touch lives here. Post bodies are model output and are rendered as text nodes,
// never as markup - which is also why nothing in this file assigns innerHTML.

import {
    BODY_CLASS,
    KIND_AMBIENT,
    KIND_CHARACTER,
    KIND_PERSONA,
    POST_MAX_CHARS,
    REPLY_MAX_CHARS,
    handleIndex,
    matchesTimelineQuery,
    needsCatchUp,
    snapshotOf,
    insertMention,
    matchMentionAccounts,
    mentionQueryAt,
    RECENT_WINDOW_HOURS,
    engagementScore,
    formatCount,
    buildNotifications,
    countUnseen,
    rankScore,
    discountRepeatAuthors,
    mentionsHandle,
    summarizeRefresh,
    isAnswerable,
    removeReply,
    restoreReply,
} from './core.js';
import * as api from './api.js';

const LAUNCH_ID = 'sbtw-launch-button';
const WAND_ID = 'sbtw-wand-button';
const DRAWER_ID = 'sbtw-drawer';
const EXTENSION_NAME = 'SillyBunny-Hopper';
const FEED_LIMIT = 160;
const SEARCH_DEBOUNCE_MS = 150;

const state = {
    body: null,
    session: null,
    feed: null,
    accounts: [],
    view: 'timeline',
    tab: 'main',
    /** Which notifications tab is open, and the seen-mark from before the view was opened (rows newer than it show as new). */
    notifTab: 'likes',
    notifSeenBefore: 0,
    /** The timeline's seen-mark from before this visit: posts and replies newer than it wear a dot. */
    timelineSeenBefore: 0,
    /** `${postId}:like` or `${postId}:repost` while a who-did-this list is open. */
    engagementFor: null,
    profileKey: null,
    replyingTo: null,
    status: '',
    busy: false,
    draft: { text: '', image: '', poll: null },
    // Persona the current draft belongs to; a draft left by another persona is discarded.
    draftOwner: null,
    characterSearch: '',
    timelineSearch: '',
    /** Bumped whenever a refresh lands (or the timeline is reset); Main's ranking is frozen in between. */
    feedEpoch: 0,
};

const owned = new Set();

// One workspace at a time; async work belongs to a session and dies with it.
let openTask = null;
let sessionTask = null;
let closingTask = Promise.resolve();
let transitionEpoch = 0;
let pendingPersonaSwitch = '';
let accountRequest = 0;
let sessionEpoch = 0;
let workController = null;
const scrollPositions = new Map();

function freshSignal() {
    // Aborting also invalidates every run holding the previous signal.
    workController?.abort();
    workController = new AbortController();
    return { epoch: ++sessionEpoch, signal: workController.signal };
}

function invalidateWork() {
    sessionEpoch += 1;
    workController?.abort();
    workController = null;
}

/** The user's Stop button: aborts the running model work but keeps the run live, so its own catch reports the outcome. */
function stopWork() {
    workController?.abort();
}

function isLive(epoch) {
    return epoch === sessionEpoch && state.body !== null;
}

// Monotonic counter of refresh runs; only the newest may touch shared busy/status state.
let refreshRuns = 0;

const dateFormat = new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
});

// --- tiny DOM helpers -----------------------------------------------------

function el(tag, options = {}, children = []) {
    const node = document.createElement(tag);
    if (options.className) {
        node.className = options.className;
    }
    if (options.text !== undefined) {
        node.textContent = String(options.text);
    }
    for (const [key, value] of Object.entries(options.attrs ?? {})) {
        if (value !== null && value !== undefined && value !== false) {
            node.setAttribute(key, String(value));
        }
    }
    for (const [event, handler] of Object.entries(options.on ?? {})) {
        node.addEventListener(event, handler);
    }
    for (const child of [].concat(children)) {
        if (child) {
            node.append(child);
        }
    }
    return node;
}

function icon(name) {
    return el('i', { className: `fa-solid ${name}`, attrs: { 'aria-hidden': 'true' } });
}

/** The SillyBunny bunny (the same mark as the Terminal UI), sized and coloured like a Font Awesome icon. */
const SVG_NS = 'http://www.w3.org/2000/svg';
const BUNNY_PATH = 'M30 40C28 26 27 12 33 9C39 6 42 20 42 34C44 33 52 33 54 34C54 20 57 6 63 9C69 12 68 26 66 40C74 46 78 54 78 63C78 78 65 88 48 88C31 88 18 78 18 63C18 54 22 46 30 40ZM34 15C32 22 32 29 35 33C38 29 38 20 37 14C36 12 35 13 34 15ZM59 14C58 20 58 29 61 33C64 29 64 22 62 15C61 13 60 12 59 14ZM34 60a4.5 4.5 0 1 0 9 0a4.5 4.5 0 1 0-9 0M53 60a4.5 4.5 0 1 0 9 0a4.5 4.5 0 1 0-9 0M45 69l6 0l-3 4.5z';

function bunnyIcon(className = '') {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 96 96');
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('fill-rule', 'evenodd');
    path.setAttribute('d', BUNNY_PATH);
    svg.append(path);
    // An <i>, like a Font Awesome glyph: the host hides <span> labels in icon-only modes, not icons.
    const node = el('i', { className: `sbtw-bunny${className ? ' ' + className : ''}`, attrs: { 'aria-hidden': 'true' } });
    node.append(svg);
    return node;
}

function button(label, className, onClick, { iconName = '', title = '', ariaLabel = '', pressed = null, disabled = false, focusKey = label } = {}) {
    const node = el('button', {
        className,
        attrs: {
            type: 'button',
            title: title || label,
            'aria-label': ariaLabel || null,
            'aria-pressed': pressed === null ? null : String(pressed),
            'data-focus-key': focusKey,
            disabled: disabled ? 'disabled' : null,
        },
        on: { click: onClick },
    }, iconName ? [icon(iconName), el('span', { text: label })] : [el('span', { text: label })]);
    return node;
}

function toast(message, type = 'info') {
    globalThis.toastr?.[type]?.(message, 'Hopper');
}

const UNDO_WINDOW = 8000;

/**
 * A toast with a real Undo button. Focus moves onto the button so keyboard users can reach it; toastr
 * keeps a focused toast alive, so the timer is re-armed when focus leaves. Returns false without toastr.
 */
function undoToast(message, undo) {
    const toastr = globalThis.toastr;
    if (!toastr) {
        return false;
    }
    let $toast = null;
    const undoButton = button('Undo', 'sbtw-undo-button', () => {
        toastr.clear($toast, { force: true });
        undo();
    });
    undoButton.addEventListener('blur', () => setTimeout(() => toastr.clear($toast), UNDO_WINDOW));
    const node = el('span', { className: 'sbtw-undo' }, [el('span', { text: message }), undoButton]);
    $toast = toastr.info(node, 'Hopper', {
        escapeHtml: false,
        tapToDismiss: false,
        timeOut: UNDO_WINDOW,
        extendedTimeOut: UNDO_WINDOW,
    });
    undoButton.focus({ preventScroll: true });
    return true;
}

function focusControl(key) {
    state.body?.querySelector(`[data-focus-key="${key}"]`)?.focus({ preventScroll: true });
}

// Bumped on every image pick; a finished upload with a stale token is discarded.
let uploadToken = 0;

// --- feed helpers ---------------------------------------------------------

function accountFor(key) {
    return state.accounts.find(account => account.key === key) ?? null;
}

function personaAccount() {
    return state.accounts.find(account => account.kind === KIND_PERSONA) ?? null;
}

function nameFor(key, snapshot) {
    return accountFor(key)?.name ?? snapshot?.name ?? 'Unknown';
}

function handleFor(key, snapshot) {
    return accountFor(key)?.handle ?? snapshot?.handle ?? 'unknown';
}

// One pass over the interactions per render, instead of a full scan inside every
// comparator and every post node. Rebuilt at the top of render().
const EMPTY_STATS = { all: [], items: [], like: 0, repost: 0, reply: 0, vote: 0, mine: new Map(), latestReplyAt: 0, onReply: new Map() };
const EMPTY_REPLY_STATS = { items: [], like: 0, repost: 0, reply: 0, mine: new Map() };
let byPost = new Map();

/** A like or repost whose parent is a comment sits on that comment, not on the post. */
function onComment(item) {
    return (item.type === 'like' || item.type === 'repost') && Boolean(item.parentInteractionId);
}

/** The nearest quote above a reply owns it, however deep the reply/repost-comment chain. */
function quoteOwner(item, interactionsById) {
    const seen = new Set();
    let parent = interactionsById.get(item.parentInteractionId);
    while (parent && !seen.has(parent.id)) {
        if (parent.type === 'repost' && parent.content) {
            return parent.id;
        }
        seen.add(parent.id);
        parent = interactionsById.get(parent.parentInteractionId);
    }
    return null;
}

function buildInteractionMap() {
    const map = new Map();
    const me = personaAccount();
    const interactionsById = new Map(state.feed.interactions.map(item => [item.id, item]));
    for (const item of state.feed.interactions) {
        let entry = map.get(item.postId);
        if (!entry) {
            entry = { all: [], items: [], like: 0, repost: 0, reply: 0, vote: 0, mine: new Map(), latestReplyAt: 0, onReply: new Map() };
            map.set(item.postId, entry);
        }
        entry.all.push(item);
        const bucketId = onComment(item)
            ? item.parentInteractionId
            : item.type === 'reply' ? quoteOwner(item, interactionsById) : null;
        if (bucketId) {
            let bucket = entry.onReply.get(bucketId);
            if (!bucket) {
                bucket = { items: [], like: 0, repost: 0, reply: 0, mine: new Map() };
                entry.onReply.set(bucketId, bucket);
            }
            bucket.items.push(item);
            bucket[item.type] += 1;
            if (me && item.actorKey === me.key) {
                bucket.mine.set(item.type, item);
            }
            continue;
        }
        entry.items.push(item);
        entry[item.type] += 1;
        if (me && item.actorKey === me.key) {
            entry.mine.set(item.type, item);
        }
        // Only other people's replies bump a conversation in Main: your own answer must not
        // fling the post you are reading to the top of the list.
        if (item.type === 'reply' && item.actorKey !== me?.key && item.createdAt > entry.latestReplyAt) {
            entry.latestReplyAt = item.createdAt;
        }
    }
    return map;
}

function statsFor(postId) {
    return byPost.get(postId) ?? EMPTY_STATS;
}

function interactionsFor(postId) {
    return statsFor(postId).items;
}

function allInteractionsFor(postId) {
    return statsFor(postId).all;
}

function countOf(postId, type) {
    return statsFor(postId)[type] ?? 0;
}

function myInteraction(postId, type) {
    return statsFor(postId).mine.get(type) ?? null;
}

function replyStatsFor(postId, replyId) {
    return statsFor(postId).onReply.get(replyId) ?? EMPTY_REPLY_STATS;
}

function replyBucketOwner(postId, replyId) {
    for (const [ownerId, bucket] of statsFor(postId).onReply) {
        if (bucket.items.some(item => item.id === replyId)) {
            return ownerId;
        }
    }
    return null;
}

/** The comment with this id on this post: a reply, or a quote of it. Quote replies live in the quote's own bucket. */
function answerableOn(postId, id) {
    return allInteractionsFor(postId).find(item => isAnswerable(item) && item.id === id)
        ?? null;
}

/** Only replies bump a conversation; likes and votes must not reorder the timeline. */
function activityAt(post) {
    return Math.max(post.createdAt, statsFor(post.id).latestReplyAt);
}

function followingKeys() {
    const me = personaAccount();
    return new Set(me ? (state.session?.follows[me.key] ?? []) : []);
}

// Main's order is frozen between refreshes: likes and replies change the scores, and a
// feed that reorders under your finger is exactly the jump we avoid. Entries that appear
// in between (your own posts) sit on top, newest first.
let mainRank = { key: '', order: new Map() };

function entryKey(entry) {
    return entry.repost ? `repost:${entry.repost.id}` : `post:${entry.post.id}`;
}

/** How often the persona has liked, replied to or reposted each author: a cheap stand-in for "accounts you interact with". */
function authorAffinity(me) {
    const map = new Map();
    if (!me) {
        return map;
    }
    const authorOf = new Map(state.feed.posts.map(post => [post.id, post.authorKey]));
    for (const item of state.feed.interactions) {
        const author = item.actorKey === me.key && item.type !== 'vote' ? authorOf.get(item.postId) : null;
        if (author && author !== me.key) {
            map.set(author, (map.get(author) ?? 0) + 1);
        }
    }
    return map;
}

function mainComparator(entries, me, following) {
    const key = `${state.session?.id ?? ''}|${state.feedEpoch}`;
    if (mainRank.key !== key) {
        const affinity = authorAffinity(me);
        const handle = me ? handleFor(me.key) : '';
        const now = Date.now();
        for (const entry of entries) {
            const stats = statsFor(entry.post.id);
            const actorKey = entry.repost ? entry.repost.actorKey : entry.post.authorKey;
            entry.score = rankScore({
                createdAt: entry.repost ? entry.repost.createdAt : entry.post.createdAt,
                latestActivityAt: entry.repost ? 0 : stats.latestReplyAt,
                like: entry.repost ? 0 : stats.like,
                reply: entry.repost ? 0 : stats.reply,
                repost: entry.repost ? 0 : stats.repost,
                vote: entry.repost ? 0 : stats.vote,
                followed: following.has(actorKey),
                mine: Boolean(me) && actorKey === me.key,
                mentionsMe: mentionsHandle(entry.repost?.content ?? entry.post.body, handle),
                affinity: affinity.get(actorKey) ?? 0,
            }, now);
        }
        discountRepeatAuthors(entries, entry => entry.repost ? entry.repost.actorKey : entry.post.authorKey);
        const ranked = [...entries].sort((a, b) => (b.score - a.score) || (b.sortAt - a.sortAt));
        mainRank = { key, order: new Map(ranked.map((entry, index) => [entryKey(entry), index])) };
    }
    const order = mainRank.order;
    return (a, b) => {
        const ra = order.get(entryKey(a));
        const rb = order.get(entryKey(b));
        if (ra === undefined || rb === undefined) {
            return ra === undefined && rb === undefined ? b.sortAt - a.sortAt : (ra === undefined ? -1 : 1);
        }
        return ra - rb;
    };
}

function visibleTimelineEntries(query = state.timelineSearch) {
    const me = personaAccount();
    const following = followingKeys();
    const relevantReposters = new Set([...following, ...(me ? [me.key] : [])]);
    const entries = state.feed.posts.map((post) => {
        const repost = state.tab === 'following'
            ? interactionsFor(post.id)
                .filter(item => item.type === 'repost' && relevantReposters.has(item.actorKey))
                .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
            : null;
        return {
            post,
            repost,
            // Latest is strictly newest first; everywhere else a reply bumps the conversation.
            sortAt: state.tab === 'latest' ? post.createdAt : Math.max(activityAt(post), repost?.createdAt ?? 0),
        };
    }).filter(({ post, repost }) => state.tab !== 'following'
        || post.authorKey === me?.key
        || following.has(post.authorKey)
        || repost);

    // A reposted comment is its own entry, carrying the comment: in Following when the
    // reposter is you or someone you follow, like a plain repost of a post.
    if (state.tab === 'following') {
        for (const post of state.feed.posts) {
            for (const [replyId, bucket] of statsFor(post.id).onReply) {
                const repost = bucket.items
                    .filter(item => item.type === 'repost' && relevantReposters.has(item.actorKey))
                    .sort((a, b) => b.createdAt - a.createdAt)[0];
                const reply = repost ? answerableOn(post.id, replyId) : null;
                if (reply) {
                    entries.push({ post, reply, repost, sortAt: repost.createdAt });
                }
            }
        }
    }

    // A repost with a comment is a quote: it gets its own entry in Main and Latest, as on the real thing.
    if (state.tab === 'main' || state.tab === 'latest') {
        const byId = new Map(state.feed.posts.map(post => [post.id, post]));
        for (const item of state.feed.interactions) {
            if (item.type === 'repost' && item.content && byId.has(item.postId)) {
                const reply = item.parentInteractionId ? answerableOn(item.postId, item.parentInteractionId) : null;
                if (item.parentInteractionId && !reply) {
                    continue;
                }
                entries.push({ post: byId.get(item.postId), reply, repost: item, sortAt: item.createdAt });
            }
        }
    }

    // Trending: the most talked-about posts of the last two days, most engaged first.
    if (state.tab === 'trending') {
        const since = Date.now() - RECENT_WINDOW_HOURS * 3600 * 1000;
        for (const entry of entries) {
            entry.score = engagementScore(statsFor(entry.post.id));
        }
        const trending = entries
            .filter(entry => entry.score > 0 && entry.sortAt >= since)
            .filter(({ post }) => matchesTimelineSearch(post, query))
            .sort((a, b) => (b.score - a.score) || (b.sortAt - a.sortAt));
        return { entries: trending.slice(0, FEED_LIMIT), total: trending.length };
    }

    const order = state.tab === 'main' ? mainComparator(entries, me, following) : (a, b) => b.sortAt - a.sortAt;
    const matches = entries
        .filter(({ post }) => matchesTimelineSearch(post, query))
        .sort(order);
    const visible = matches.slice(0, FEED_LIMIT);
    const targetPostId = state.replyingTo?.postId;
    if (!String(query ?? '').trim() && targetPostId && !visible.some(entry => entry.post.id === targetPostId)) {
        const target = entries.find(entry => entry.post.id === targetPostId);
        if (target) {
            visible.unshift(target);
            visible.length = Math.min(visible.length, FEED_LIMIT);
        }
    }
    return { entries: visible, total: matches.length };
}

/** Search every rendered comment, using live account names instead of stale snapshots. */
function matchesTimelineSearch(post, query) {
    if (!String(query ?? '').trim()) {
        return true;
    }
    const comments = allInteractionsFor(post.id)
        .filter(item => item.type === 'reply' || (item.type === 'repost' && item.content))
        .map(item => ({
            ...item,
            actorSnapshot: accountFor(item.actorKey) ?? item.actorSnapshot,
        }));
    return matchesTimelineQuery({
        ...post,
        authorSnapshot: accountFor(post.authorKey) ?? post.authorSnapshot,
    }, comments, query);
}

function persist() {
    api.saveFeedDebounced(state.feed, 1200, state.session.id);
}

// --- rendering ------------------------------------------------------------

function avatarNode(account, size = 'md') {
    const url = account ? api.avatarUrl(account) : '';
    if (url) {
        return el('img', {
            className: `sbtw-avatar sbtw-avatar-${size}`,
            attrs: { src: url, alt: '', loading: 'lazy', decoding: 'async' },
        });
    }
    const name = account?.name ?? '?';
    const initials = name.split(/\s+/).slice(0, 2).map(part => part[0] ?? '').join('').toUpperCase() || '?';
    return el('span', { className: `sbtw-avatar sbtw-avatar-${size} sbtw-avatar-initials`, text: initials });
}

/** An avatar you can tap to open that account's profile, where the name is not the only way there. */
function avatarButton(account, size, key) {
    const name = account?.name ?? 'Unknown';
    return el('button', {
        className: 'sbtw-avatar-button',
        attrs: { type: 'button', title: `${name}'s profile`, 'aria-label': `${name}'s profile` },
        on: { click: () => showProfile(key) },
    }, [avatarNode(account, size)]);
}

/** Entering the timeline freezes its seen-mark, so what arrived since the last visit stays marked while it is read. */
function markTimelineVisit() {
    state.timelineSeenBefore = state.session?.timelineSeenAt ?? 0;
}

/** Arrived since the last visit, and not written by you. */
function isNewToMe(item, authorKey) {
    const me = personaAccount();
    return item.createdAt > state.timelineSeenBefore && authorKey !== me?.key;
}

function newDot() {
    return el('span', { className: 'sbtw-new-dot', attrs: { role: 'img', title: 'New since your last visit', 'aria-label': 'New since your last visit' } });
}

/** Renders body text as text nodes, turning @handles that match a real account into links. */
function bodyNode(text) {
    const fragment = document.createDocumentFragment();
    const known = handleIndex(state.accounts);
    const pattern = /(^|[^a-z0-9_])@([a-z0-9_]{1,20})(?![a-z0-9_])/gi;
    let cursor = 0;
    for (const match of String(text ?? '').matchAll(pattern)) {
        const account = known.get(match[2].toLowerCase());
        if (!account) {
            continue;
        }
        const mentionAt = match.index + match[1].length;
        if (mentionAt > cursor) {
            fragment.append(document.createTextNode(text.slice(cursor, mentionAt)));
        }
        fragment.append(el('button', {
            className: 'sbtw-mention',
            text: `@${account.handle}`,
            attrs: { type: 'button' },
            on: { click: () => showProfile(account.key) },
        }));
        cursor = match.index + match[0].length;
    }
    if (cursor < String(text ?? '').length) {
        fragment.append(document.createTextNode(text.slice(cursor)));
    }
    return fragment;
}

/** Who picked this option: a pile of small avatars, named by the tooltip and for screen readers. */
function pollVotersNode(voters) {
    if (!voters.length) {
        return null;
    }
    const names = voters.map(vote => `${nameFor(vote.actorKey, vote.actorSnapshot)} (@${handleFor(vote.actorKey, vote.actorSnapshot)})`);
    const label = `Voted by ${names.join(', ')}`;
    return el('span', {
        className: 'sbtw-poll-voters',
        attrs: { role: 'img', 'aria-label': label, title: label },
    }, voters.map(vote => avatarNode(accountFor(vote.actorKey) ?? vote.actorSnapshot ?? null, 'xs')));
}

function pollNode(post) {
    if (!post.poll) {
        return null;
    }
    const votes = interactionsFor(post.id).filter(item => item.type === 'vote');
    const mine = myInteraction(post.id, 'vote');
    const total = votes.length;
    const rows = post.poll.options.map((option, index) => {
        const voters = votes.filter(vote => vote.pollOptionIndex === index);
        const count = voters.length;
        const share = total ? Math.round((count / total) * 100) : 0;
        const selected = mine?.pollOptionIndex === index;
        const bar = el('span', { className: 'sbtw-poll-bar' });
        bar.style.setProperty('--sbtw-poll-share', `${share}%`);
        const row = el('button', {
            className: `sbtw-poll-option${selected ? ' sbtw-poll-mine' : ''}`,
            attrs: {
                type: 'button',
                'aria-pressed': String(selected),
                'data-focus-key': `poll:${post.id}:${index}`,
                disabled: personaAccount() ? null : 'disabled',
            },
            on: { click: () => vote(post, index) },
        }, [
            bar,
            el('span', { className: 'sbtw-poll-text', text: option.text }),
            pollVotersNode(voters),
            el('span', { className: 'sbtw-poll-share', text: total ? `${share}%` : '' }),
        ]);
        return row;
    });
    return el('div', { className: 'sbtw-poll' }, [
        post.poll.question ? el('div', { className: 'sbtw-poll-question', text: post.poll.question }) : null,
        ...rows,
        el('div', { className: 'sbtw-poll-total', text: total === 1 ? '1 vote' : `${total} votes` }),
    ]);
}

function imageNode(post) {
    if (!post.image?.url) {
        return null;
    }
    // Known dimensions reserve the box before the image arrives, so a re-render cannot shift
    // everything below it once it loads. Measured on first sight and saved with the post.
    const feed = state.feed;
    const sessionId = state.session?.id;
    const img = el('img', { attrs: { src: post.image.url, alt: post.image.prompt ?? '', loading: 'lazy', width: post.image.width || null, height: post.image.height || null } });
    if (!post.image.width) {
        img.addEventListener('load', () => {
            if (img.naturalWidth && img.naturalHeight && !post.image.width
                && img.isConnected && state.body?.isConnected && state.feed === feed
                && state.session?.id === sessionId) {
                post.image.width = img.naturalWidth;
                post.image.height = img.naturalHeight;
                api.saveFeedDebounced(feed, 1200, sessionId);
            }
        }, { once: true });
    }
    return el('button', {
        className: 'sbtw-image',
        attrs: { type: 'button', title: 'Open image' },
        on: { click: () => openImage(post.image.url) },
    }, [img]);
}

const replyDrafts = new Map();
let pendingReplyFocus = null;

/**
 * iOS: the host's Safari patch (browser-fixes.js → mobile-shell-lifecycle) cancels every
 * horizontal touch pan inside the chat chrome unless the scroller is on its hard-coded list
 * of rails, and an extension cannot get on that list. Its handler sits on document in the
 * capture phase; window capture runs first, so a sideways swipe that starts in the trend
 * row is kept from reaching it. Nothing is prevented: the row still scrolls natively.
 */
let trendPanGuard = null;
function installTrendPanGuard() {
    if (trendPanGuard || typeof window === 'undefined') {
        return;
    }
    let start = null;
    const touchstart = (event) => {
        const touch = event.touches?.[0];
        const inRow = touch && event.target instanceof Element && event.target.closest('.sbtw-trends');
        start = inRow && event.touches.length === 1 ? { x: touch.clientX, y: touch.clientY } : null;
    };
    const touchmove = (event) => {
        if (!start || event.touches?.length !== 1) {
            return;
        }
        const touch = event.touches[0];
        if (Math.abs(touch.clientX - start.x) > Math.abs(touch.clientY - start.y)) {
            event.stopPropagation();
        }
    };
    const clear = () => { start = null; };
    trendPanGuard = { touchstart, touchmove, clear };
    window.addEventListener('touchstart', touchstart, { capture: true, passive: true });
    window.addEventListener('touchmove', touchmove, { capture: true, passive: true });
    window.addEventListener('touchend', clear, { capture: true, passive: true });
    window.addEventListener('touchcancel', clear, { capture: true, passive: true });
}

function removeTrendPanGuard() {
    if (!trendPanGuard || typeof window === 'undefined') {
        return;
    }
    window.removeEventListener('touchstart', trendPanGuard.touchstart, true);
    window.removeEventListener('touchmove', trendPanGuard.touchmove, true);
    window.removeEventListener('touchend', trendPanGuard.clear, true);
    window.removeEventListener('touchcancel', trendPanGuard.clear, true);
    trendPanGuard = null;
}

function replyTargetKey(target) {
    return JSON.stringify([target.postId, target.parentInteractionId ?? null]);
}

function isReplyTarget(postId, parentInteractionId = null) {
    return state.replyingTo?.postId === postId
        && state.replyingTo?.parentInteractionId === parentInteractionId;
}

function setReplyTarget(postId, parentInteractionId = null, { toggle = true } = {}) {
    const target = { postId, parentInteractionId };
    const same = isReplyTarget(postId, parentInteractionId);
    if (toggle && same) {
        replyDrafts.delete(replyTargetKey(target));
        state.replyingTo = null;
        pendingReplyFocus = null;
    } else {
        state.replyingTo = target;
        pendingReplyFocus = replyTargetKey(target);
    }
    render();
}

/** One action on a post or a comment. With `who`, the count is its own button that opens the list of who did it. */
function actionButton(ownerId, me, iconName, count, active, onClick, label, who = null) {
    const button = el('button', {
        className: `sbtw-action${active ? ' sbtw-action-on' : ''}`,
        attrs: {
            type: 'button',
            title: label,
            'aria-label': label,
            'aria-pressed': String(active),
            'data-focus-key': `action:${ownerId}:${iconName}`,
            disabled: me ? null : 'disabled',
        },
        on: { click: onClick },
    }, [icon(iconName)]);
    if (!(count > 0)) {
        return button;
    }
    if (!who) {
        button.append(el('span', { className: 'sbtw-action-count', text: String(count) }));
        return button;
    }
    // The count is its own button: tap it to see who did this, without toggling your own like.
    const key = `${ownerId}:${who}`;
    const open = state.engagementFor === key;
    const countButton = el('button', {
        className: `sbtw-action-count sbtw-action-who${open ? ' sbtw-action-who-on' : ''}`,
        text: String(count),
        attrs: { type: 'button', title: who === 'like' ? 'See who liked this' : 'See who reposted this', 'aria-label': `${count} ${who === 'like' ? 'likes' : 'reposts'}, see who`, 'aria-expanded': String(open), 'data-focus-key': `engagement:${ownerId}:${who}` },
        on: { click: () => { state.engagementFor = open ? null : key; render(); } },
    });
    return el('span', { className: 'sbtw-action-group' }, [button, countButton]);
}

function actionsNode(post) {
    const me = personaAccount();
    const liked = Boolean(myInteraction(post.id, 'like'));
    const reposted = Boolean(myInteraction(post.id, 'repost'));
    const replies = countOf(post.id, 'reply');
    const action = (...args) => actionButton(post.id, me, ...args);

    return el('div', { className: 'sbtw-actions' }, [
        action('fa-heart', countOf(post.id, 'like'), liked, () => toggle(post.id, 'like'), liked ? 'Unlike' : 'Like', 'like'),
        action('fa-retweet', countOf(post.id, 'repost'), reposted, () => toggle(post.id, 'repost'), reposted ? 'Undo repost' : 'Repost', 'repost'),
        action('fa-comment', replies, isReplyTarget(post.id), () => setReplyTarget(post.id), 'Reply'),
    ]);
}

/** Who liked or reposted a post, shown under its actions while the count is open. */
function engagementNode(ownerId, interactions) {
    const key = String(state.engagementFor ?? '');
    if (!key.startsWith(`${ownerId}:`)) {
        return null;
    }
    const type = key.slice(ownerId.length + 1);
    const items = interactions
        .filter(item => item.type === type)
        .sort((a, b) => b.createdAt - a.createdAt);
    const title = type === 'like' ? 'Liked by' : 'Reposted by';
    return el('div', { className: 'sbtw-engagement', attrs: { role: 'region', 'aria-label': title } }, [
        el('div', { className: 'sbtw-engagement-title', text: title }),
        ...(items.length ? items.map((item) => {
            const account = accountFor(item.actorKey) ?? item.actorSnapshot ?? null;
            return el('div', { className: 'sbtw-engagement-row' }, [
                avatarButton(account, 'sm', item.actorKey),
                el('button', {
                    className: 'sbtw-name',
                    text: nameFor(item.actorKey, item.actorSnapshot),
                    attrs: { type: 'button' },
                    on: { click: () => showProfile(item.actorKey) },
                }),
                el('span', { className: 'sbtw-handle', text: `@${handleFor(item.actorKey, item.actorSnapshot)}` }),
            ]);
        }) : [el('div', { className: 'sbtw-hint', text: 'Nobody yet.' })]),
    ]);
}

function replyNode(reply) {
    const parent = reply.parentInteractionId
        ? state.feed.interactions.find(item => item.id === reply.parentInteractionId)
        : null;
    const account = accountFor(reply.actorKey);
    const me = personaAccount();
    const handle = handleFor(reply.actorKey, reply.actorSnapshot);
    const targeted = isReplyTarget(reply.postId, reply.id);
    const stats = replyStatsFor(reply.postId, reply.id);
    const liked = Boolean(stats.mine.get('like'));
    const reposted = Boolean(stats.mine.get('repost'));
    const fresh = isNewToMe(reply, reply.actorKey);
    return el('div', { className: `sbtw-reply${fresh ? ' sbtw-reply-new' : ''}`, attrs: { 'data-kind': reply.actorSnapshot?.kind ?? '', 'data-reply-id': reply.id } }, [
        // The avatar shares a row with the name block so it stays centred on it even when the time wraps.
        el('div', { className: 'sbtw-reply-head' }, [
            avatarButton(account ?? reply.actorSnapshot ?? null, 'sm', reply.actorKey),
            el('div', { className: 'sbtw-meta' }, [
                fresh ? newDot() : null,
                el('button', {
                    className: 'sbtw-name',
                    text: nameFor(reply.actorKey, reply.actorSnapshot),
                    attrs: { type: 'button' },
                    on: { click: () => showProfile(reply.actorKey) },
                }),
                el('span', { className: 'sbtw-handle', text: `@${handle}` }),
                el('span', { className: 'sbtw-time', text: dateFormat.format(new Date(reply.createdAt)) }),
            ]),
        ]),
        el('div', { className: 'sbtw-reply-main' }, [
            parent
                ? el('div', {
                    className: 'sbtw-replying',
                    text: `Replying to @${handleFor(parent.actorKey, parent.actorSnapshot)}`,
                })
                : null,
            el('div', { className: 'sbtw-body' }, [bodyNode(reply.content)]),
            el('div', { className: 'sbtw-reply-actions' }, [
                actionButton(reply.id, me, 'fa-heart', stats.like, liked, () => toggle(reply.postId, 'like', reply), liked ? 'Unlike' : 'Like', 'like'),
                actionButton(reply.id, me, 'fa-retweet', stats.repost, reposted, () => toggle(reply.postId, 'repost', reply), reposted ? 'Undo repost' : 'Repost', 'repost'),
                me ? button('Reply', `sbtw-action${targeted ? ' sbtw-action-on' : ''}`,
                    () => setReplyTarget(reply.postId, reply.id), {
                        iconName: 'fa-comment',
                        ariaLabel: `Reply to @${handle}`,
                        pressed: targeted,
                        focusKey: `reply:${reply.id}`,
                    }) : null,
                me?.key === reply.actorKey
                    ? button('Delete', 'sbtw-action sbtw-action-danger', () => deleteReply(reply), {
                        iconName: 'fa-trash',
                        ariaLabel: 'Delete your reply',
                        focusKey: `delete-reply:${reply.id}`,
                    })
                    : null,
            ]),
            engagementNode(reply.id, stats.items),
        ]),
    ]);
}

/** Someone reposted a comment: the reposter speaks first if they added a comment, then the comment, then the post it was on. */
function repostedReplyNode({ post, reply, repost }) {
    const actor = accountFor(repost.actorKey);
    const me = personaAccount();
    const stats = replyStatsFor(post.id, repost.id);
    const liked = Boolean(stats.mine.get('like'));
    const reposted = Boolean(stats.mine.get('repost'));
    const targeted = isReplyTarget(post.id, repost.id);
    const target = state.replyingTo?.parentInteractionId
        ? answerableOn(post.id, state.replyingTo.parentInteractionId)
        : null;
    const composerHere = state.replyingTo?.postId === post.id
        && (targeted || (target?.type === 'reply' && replyBucketOwner(post.id, target.id) === repost.id));
    const replies = stats.items.filter(item => item.type === 'reply').sort((a, b) => a.createdAt - b.createdAt);
    return el('article', { className: 'sbtw-post sbtw-reply-repost', attrs: { 'data-repost-id': repost.id } }, [
        el('div', { className: 'sbtw-repost-context' }, [
            icon('fa-retweet'),
            el('span', { text: `${nameFor(repost.actorKey, repost.actorSnapshot)} reposted a reply${repost.content ? ' with a comment' : ''}` }),
        ]),
        repost.content ? el('div', { className: 'sbtw-post-row' }, [
            avatarButton(actor ?? repost.actorSnapshot ?? null, 'md', repost.actorKey),
            el('div', { className: 'sbtw-post-main' }, [
                el('div', { className: 'sbtw-meta' }, [
                    el('button', {
                        className: 'sbtw-name',
                        text: nameFor(repost.actorKey, repost.actorSnapshot),
                        attrs: { type: 'button' },
                        on: { click: () => showProfile(repost.actorKey) },
                    }),
                    el('span', { className: 'sbtw-handle', text: `@${handleFor(repost.actorKey, repost.actorSnapshot)}` }),
                    el('span', { className: 'sbtw-time', text: dateFormat.format(new Date(repost.createdAt)) }),
                ]),
                el('div', { className: 'sbtw-body' }, [bodyNode(repost.content)]),
            ]),
        ]) : null,
        replyNode(reply),
        el('div', { className: 'sbtw-quote-card' }, [postNode(post, null, { compact: true })]),
        repost.content ? el('div', { className: 'sbtw-actions' }, [
            actionButton(repost.id, me, 'fa-heart', stats.like, liked, () => toggle(post.id, 'like', repost), liked ? 'Unlike' : 'Like', 'like'),
            actionButton(repost.id, me, 'fa-retweet', stats.repost, reposted, () => toggle(post.id, 'repost', repost), reposted ? 'Undo repost' : 'Repost', 'repost'),
            actionButton(repost.id, me, 'fa-comment', stats.reply, targeted, () => setReplyTarget(post.id, repost.id), 'Reply'),
        ]) : null,
        repost.content ? engagementNode(repost.id, stats.items) : null,
        repost.content && composerHere ? replyComposer(post) : null,
        repost.content && replies.length ? el('div', { className: 'sbtw-replies' }, replies.map(replyNode)) : null,
    ]);
}

/** A post card. `compact` is the embedded form inside a quote: no actions, replies or delete, and no scroll anchor. */
function postNode(post, repost = null, { compact = false } = {}) {
    if (repost?.content && !compact) {
        return quoteNode(post, repost);
    }
    const account = accountFor(post.authorKey);
    const me = personaAccount();
    const mine = me && post.authorKey === me.key && !compact;
    const replies = compact ? [] : interactionsFor(post.id)
        .filter(item => item.type === 'reply')
        .sort((a, b) => a.createdAt - b.createdAt);
    const replyParent = !compact && state.replyingTo?.postId === post.id && state.replyingTo.parentInteractionId
        ? answerableOn(post.id, state.replyingTo.parentInteractionId)
        : null;
    const replyOwner = replyParent ? replyBucketOwner(post.id, replyParent.id) : null;

    const fresh = !compact && isNewToMe(post, post.authorKey);
    return el('article', { className: `sbtw-post${compact ? ' sbtw-post-compact' : ''}${fresh ? ' sbtw-post-new' : ''}`, attrs: compact ? {} : { 'data-post-id': post.id } }, [
        repost ? el('div', { className: 'sbtw-repost-context' }, [
            icon('fa-retweet'),
            el('span', { text: `${nameFor(repost.actorKey, repost.actorSnapshot)} reposted` }),
        ]) : null,
        el('div', { className: 'sbtw-post-row' }, [
            avatarButton(account ?? post.authorSnapshot ?? null, compact ? 'sm' : 'md', post.authorKey),
            el('div', { className: 'sbtw-post-main' }, [
                el('div', { className: 'sbtw-meta' }, [
                    // The dot leads the row: the name block wraps on a phone, and a trailing dot ends up stranded on a line of its own.
                    fresh ? newDot() : null,
                    el('button', {
                        className: 'sbtw-name',
                        text: nameFor(post.authorKey, post.authorSnapshot),
                        attrs: { type: 'button' },
                        on: { click: () => showProfile(post.authorKey) },
                    }),
                    el('span', { className: 'sbtw-handle', text: `@${handleFor(post.authorKey, post.authorSnapshot)}` }),
                    el('span', { className: 'sbtw-time', text: dateFormat.format(new Date(post.createdAt)) }),
                    mine
                        ? el('button', {
                            className: 'sbtw-delete',
                            attrs: { type: 'button', title: 'Delete post', 'aria-label': 'Delete post', 'data-focus-key': `delete-post:${post.id}` },
                            on: { click: () => deletePost(post) },
                        }, [icon('fa-ellipsis')])
                        : null,
                ]),
                el('div', { className: 'sbtw-body' }, [bodyNode(post.body)]),
                pollNode(post),
                imageNode(post),
                compact ? null : actionsNode(post),
                compact ? null : engagementNode(post.id, interactionsFor(post.id)),
                !compact && state.replyingTo?.postId === post.id
                    && (!state.replyingTo.parentInteractionId || (replyParent?.type === 'reply' && !replyOwner))
                    ? replyComposer(post)
                    : null,
                replies.length ? el('div', { className: 'sbtw-replies' }, replies.map(replyNode)) : null,
            ]),
        ]),
    ]);
}

/** A repost with a comment: the reposter speaks, and the original sits in a card underneath. */
function quoteNode(post, repost) {
    const actor = accountFor(repost.actorKey);
    const me = personaAccount();
    const stats = replyStatsFor(post.id, repost.id);
    const liked = Boolean(stats.mine.get('like'));
    const reposted = Boolean(stats.mine.get('repost'));
    const targeted = isReplyTarget(post.id, repost.id);
    const target = state.replyingTo?.parentInteractionId
        ? answerableOn(post.id, state.replyingTo.parentInteractionId)
        : null;
    const composerHere = state.replyingTo?.postId === post.id
        && (targeted || (target?.type === 'reply' && replyBucketOwner(post.id, target.id) === repost.id));
    const replies = stats.items.filter(item => item.type === 'reply').sort((a, b) => a.createdAt - b.createdAt);
    return el('article', { className: 'sbtw-post sbtw-quote', attrs: { 'data-repost-id': repost.id } }, [
        el('div', { className: 'sbtw-repost-context' }, [
            icon('fa-retweet'),
            el('span', { text: `${nameFor(repost.actorKey, repost.actorSnapshot)} reposted with a comment` }),
        ]),
        el('div', { className: 'sbtw-post-row' }, [
            avatarButton(actor ?? repost.actorSnapshot ?? null, 'md', repost.actorKey),
            el('div', { className: 'sbtw-post-main' }, [
                el('div', { className: 'sbtw-meta' }, [
                    el('button', {
                        className: 'sbtw-name',
                        text: nameFor(repost.actorKey, repost.actorSnapshot),
                        attrs: { type: 'button' },
                        on: { click: () => showProfile(repost.actorKey) },
                    }),
                    el('span', { className: 'sbtw-handle', text: `@${handleFor(repost.actorKey, repost.actorSnapshot)}` }),
                    el('span', { className: 'sbtw-time', text: dateFormat.format(new Date(repost.createdAt)) }),
                ]),
                el('div', { className: 'sbtw-body' }, [bodyNode(repost.content)]),
                el('div', { className: 'sbtw-quote-card' }, [postNode(post, null, { compact: true })]),
                // A quote is its own little post: it can be liked, reposted and answered like one.
                el('div', { className: 'sbtw-actions' }, [
                    actionButton(repost.id, me, 'fa-heart', stats.like, liked, () => toggle(post.id, 'like', repost), liked ? 'Unlike' : 'Like', 'like'),
                    actionButton(repost.id, me, 'fa-retweet', stats.repost, reposted, () => toggle(post.id, 'repost', repost), reposted ? 'Undo repost' : 'Repost', 'repost'),
                    actionButton(repost.id, me, 'fa-comment', stats.reply, targeted, () => setReplyTarget(post.id, repost.id), 'Reply'),
                ]),
                engagementNode(repost.id, stats.items),
                composerHere ? replyComposer(post) : null,
                replies.length ? el('div', { className: 'sbtw-replies' }, replies.map(replyNode)) : null,
            ]),
        ]),
    ]);
}

function replyComposer(post) {
    const me = personaAccount();
    const target = state.replyingTo ?? { postId: post.id, parentInteractionId: null };
    const parent = target.parentInteractionId ? answerableOn(post.id, target.parentInteractionId) : null;
    const key = replyTargetKey(target);
    const parentHandle = parent ? handleFor(parent.actorKey, parent.actorSnapshot) : '';
    const field = el('textarea', {
        className: 'sbtw-input',
        attrs: {
            rows: '2',
            maxlength: String(REPLY_MAX_CHARS),
            placeholder: parentHandle ? `Reply to @${parentHandle}...` : `Reply as ${me?.name ?? 'you'}...`,
            'data-focus-key': `reply-composer:${key}`,
            'aria-label': parentHandle
                ? `Reply to @${parentHandle} as ${me?.name ?? 'you'}`
                : `Reply as ${me?.name ?? 'you'}`,
        },
    });
    // The draft survives re-renders; focus is only claimed when the composer opens.
    field.value = replyDrafts.get(key) ?? '';
    field.addEventListener('input', () => { replyDrafts.set(key, field.value); });
    attachMentionPicker(field);
    if (pendingReplyFocus === key) {
        pendingReplyFocus = null;
        // Focus without the browser's own scroll, then reveal the box by the shortest move rather than a jump to centre it.
        queueMicrotask(() => {
            field.focus({ preventScroll: true });
            field.scrollIntoView({ block: 'nearest' });
        });
    }
    const send = button('Reply', 'sbtw-btn sbtw-btn-primary', () => {
        const text = field.value.trim();
        if (!text) {
            return;
        }
        addReply(post, text, target.parentInteractionId);
    }, { focusKey: `send-reply:${key}` });
    return el('div', { className: 'sbtw-reply-composer' }, [
        parent ? el('div', { className: 'sbtw-replying', text: `Replying to @${parentHandle}` }) : null,
        field,
        el('div', { className: 'sbtw-composer-bar' }, [send]),
    ]);
}

/**
 * Typing @ in a composer lists the accounts this session knows (persona, invited
 * characters, ambient strangers); arrows move, Enter or Tab inserts `@handle `, Escape closes.
 */
function attachMentionPicker(field) {
    let list = null;
    let items = [];
    let active = 0;
    const close = () => {
        list?.remove();
        list = null;
        items = [];
    };
    const apply = (account) => {
        const query = mentionQueryAt(field.value, field.selectionStart ?? field.value.length);
        if (!query || !account) {
            close();
            return;
        }
        const next = insertMention(field.value, query.start, field.selectionStart ?? field.value.length, account.handle);
        field.value = next.text;
        field.setSelectionRange(next.caret, next.caret);
        field.dispatchEvent(new Event('input', { bubbles: true }));
        close();
        field.focus();
    };
    const update = () => {
        const query = mentionQueryAt(field.value, field.selectionStart ?? field.value.length);
        if (!query) {
            close();
            return;
        }
        items = matchMentionAccounts(state.accounts, query.query);
        if (!items.length) {
            close();
            return;
        }
        active = Math.min(active, items.length - 1);
        if (!list) {
            list = el('div', { className: 'sbtw-mentions', attrs: { role: 'listbox', 'aria-label': 'Accounts to mention' } });
            field.insertAdjacentElement('afterend', list);
        }
        list.replaceChildren(...items.map((account, index) => el('button', {
            className: `sbtw-mention-item${index === active ? ' sbtw-mention-on' : ''}`,
            attrs: { type: 'button', role: 'option', 'aria-selected': index === active ? 'true' : 'false' },
            on: {
                // Keep the caret in the field, or blur closes the list before the click lands.
                mousedown: event => event.preventDefault(),
                click: () => apply(account),
            },
        }, [
            avatarNode(account, 'sm'),
            el('span', { className: 'sbtw-name', text: account.name }),
            el('span', { className: 'sbtw-handle', text: `@${account.handle}` }),
        ])));
    };
    field.addEventListener('input', () => { active = 0; update(); });
    field.addEventListener('click', update);
    field.addEventListener('keyup', (event) => {
        if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
            update();
        }
    });
    field.addEventListener('keydown', (event) => {
        if (!list) {
            return;
        }
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            active = (active + 1) % items.length;
            update();
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            active = (active - 1 + items.length) % items.length;
            update();
        } else if (event.key === 'Enter' || event.key === 'Tab') {
            event.preventDefault();
            apply(items[active]);
        } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close();
        }
    });
    field.addEventListener('blur', () => setTimeout(close, 150));
}

/** One action bar for both composer states, so Refresh works even without a persona. */
function composerBar(canPost, postField = null) {
    const picker = el('input', { attrs: { type: 'file', accept: 'image/*', hidden: 'hidden' } });
    picker.addEventListener('change', async () => {
        const file = picker.files?.[0];
        picker.value = ''; // cleared immediately so the same file can be picked again
        if (!file) {
            return;
        }
        // Late uploads must not attach to a newer pick or to a post published since.
        const mine = ++uploadToken;
        const targetDraft = state.draft;
        try {
            const url = await api.uploadImage(file);
            if (mine !== uploadToken || state.draft !== targetDraft) {
                return;
            }
            targetDraft.image = url;
            render();
        } catch (error) {
            console.error('[Hopper] image upload failed', error);
            toast(error.message, 'error');
        }
    });

    return el('div', { className: 'sbtw-composer-bar' }, [
        picker,
        canPost ? button('Image', 'sbtw-btn sbtw-btn-quiet', () => picker.click(), { iconName: 'fa-image' }) : null,
        canPost && api.getSettings().polls && !state.draft.poll
            ? button('Poll', 'sbtw-btn sbtw-btn-quiet', () => { state.draft.poll = ['', '']; render(); }, { iconName: 'fa-square-poll-vertical' })
            : null,
        // While the model works the same slot becomes Stop: a refresh is a request, not a commitment.
        state.busy
            ? button('Stop', 'sbtw-btn', stopWork, { iconName: 'fa-stop', title: 'Stop the model; whatever has landed stays', ariaLabel: 'Stop the model', focusKey: 'refresh' })
            : button('Refresh', 'sbtw-btn', () => refresh(), { iconName: 'fa-rotate', title: 'Ask the model for new activity', ariaLabel: 'Refresh timeline', focusKey: 'refresh' }),
        el('span', { className: 'sbtw-spacer' }),
        // Live region: progress updates are announced without stealing focus.
        el('span', {
            className: 'sbtw-status',
            text: state.status,
            attrs: { role: 'status', 'aria-live': 'polite' },
        }),
        canPost ? button('Post', 'sbtw-btn sbtw-btn-primary sbtw-post-button', () => publish(postField.value), { focusKey: 'publish' }) : null,
    ]);
}

function composer() {
    const me = personaAccount();
    if (!me) {
        return el('div', { className: 'sbtw-composer' }, [
            el('div', { className: 'sbtw-empty', text: 'Set a persona to post. Everything else still works.' }),
            composerBar(false),
        ]);
    }

    const field = el('textarea', {
        className: 'sbtw-input sbtw-composer-input',
        attrs: { rows: '3', maxlength: String(POST_MAX_CHARS), placeholder: "What's happening?", 'aria-label': "What's happening?", 'data-focus-key': 'post-composer' },
    });
    field.value = state.draft.text;
    field.addEventListener('input', () => { state.draft.text = field.value; });
    attachMentionPicker(field);

    const extras = el('div', { className: 'sbtw-composer-extras' });
    if (state.draft.image) {
        extras.append(el('div', { className: 'sbtw-attachment' }, [
            el('img', { attrs: { src: state.draft.image, alt: '' } }),
            button('Remove', 'sbtw-btn sbtw-btn-quiet', () => { state.draft.image = ''; render(); }),
        ]));
    }
    if (state.draft.poll) {
        const rows = state.draft.poll.map((text, index) => el('input', {
            className: 'sbtw-input',
            attrs: { type: 'text', maxlength: '120', placeholder: `Option ${index + 1}`, value: text, 'data-focus-key': `poll-option:${index}` },
            on: {
                input: (event) => { state.draft.poll[index] = event.target.value; },
            },
        }));
        extras.append(el('div', { className: 'sbtw-poll-editor' }, [
            ...rows,
            el('div', { className: 'sbtw-composer-bar' }, [
                state.draft.poll.length < 4
                    ? button('Add option', 'sbtw-btn sbtw-btn-quiet', () => { state.draft.poll.push(''); render(); })
                    : null,
                button('Remove poll', 'sbtw-btn sbtw-btn-quiet', () => { state.draft.poll = null; render(); }),
            ]),
        ]));
    }

    return el('div', { className: 'sbtw-composer' }, [
        el('div', { className: 'sbtw-post-row' }, [
            avatarNode(me, 'md'),
            el('div', { className: 'sbtw-post-main' }, [field, extras]),
        ]),
        composerBar(true, field),
    ]);
}

function timelineView() {
    // Looking at the timeline clears the dots for next time; this visit keeps the ones it opened with.
    const latestReply = state.feed.interactions.reduce((latest, item) => item.type === 'reply' ? Math.max(latest, item.createdAt) : latest, 0);
    const latest = state.feed.posts.reduce((value, post) => Math.max(value, post.createdAt), latestReply);
    if (state.session && latest > (state.session.timelineSeenAt ?? 0)) {
        state.session = api.updateSession(state.session.id, { timelineSeenAt: latest });
    }
    // Plain toggle buttons: a real tab pattern needs arrow-key roving focus and
    // tabpanels we do not have, and mislabelled tabs are worse than honest buttons.
    const tabs = el('div', { className: 'sbtw-tabs' }, [
        tabButton('Main', 'main'),
        tabButton('Latest', 'latest'),
        tabButton('Following', 'following'),
        tabButton('Trending', 'trending'),
    ]);
    const results = el('div', { className: 'sbtw-timeline-results' });
    const resultStatus = el('span', {
        className: 'sbtw-search-status',
        attrs: { role: 'status', 'aria-live': 'polite' },
    });
    const search = el('input', {
        className: 'sbtw-input sbtw-timeline-search',
        attrs: {
            type: 'search',
            placeholder: 'Search this timeline',
            'aria-label': 'Search this timeline',
            autocomplete: 'off',
            value: state.timelineSearch,
            'data-focus-key': 'timeline-search',
        },
    });
    search.value = state.timelineSearch;
    const drawResults = () => {
        state.timelineSearch = search.value;
        const query = search.value.trim();
        const { entries, total } = visibleTimelineEntries(query);
        resultStatus.textContent = query ? `${total} ${total === 1 ? 'result' : 'results'}` : '';
        if (entries.length) {
            results.replaceChildren(el('div', { className: 'sbtw-list' },
                entries.map(entry => entry.reply ? repostedReplyNode(entry) : postNode(entry.post, entry.repost))));
            return;
        }
        results.replaceChildren(el('div', { className: 'sbtw-empty' }, [
            el('p', {
                text: query
                    ? 'No posts or replies match that search.'
                    : state.tab === 'following' ? 'Nothing from anyone you follow yet.'
                        : state.tab === 'trending' ? 'Nothing is trending yet.' : 'Nothing here yet.',
            }),
            el('p', {
                className: 'sbtw-hint',
                text: query
                    ? 'Try a name, handle, post, reply or poll option.'
                    : state.tab === 'following'
                        ? 'Follow someone from their profile, or from Who to follow.'
                        : state.tab === 'trending'
                            ? 'Posts with the most likes, replies and reposts from the last two days show up here.'
                            : 'Invite a character in Settings, then hit Refresh.',
            }),
        ]));
    };
    let timer = null;
    search.addEventListener('input', () => {
        state.timelineSearch = search.value;
        clearTimeout(timer);
        timer = setTimeout(() => {
            if (search.isConnected) {
                drawResults();
            }
        }, SEARCH_DEBOUNCE_MS);
    });
    drawResults();

    // Made-up trending topics, under the Trending tab: tapping one searches the timeline for it.
    let trendsBar = null;
    if (state.tab === 'trending') {
        const trends = state.session?.trends ?? [];
        installTrendPanGuard();
        trendsBar = el('div', { className: 'sbtw-trends', attrs: { 'aria-label': 'Trending topics' } }, trends.length
            ? trends.map(trend => el('button', {
                className: 'sbtw-trend',
                attrs: { type: 'button', title: `Write a round of posts about ${trend.topic}`, disabled: state.busy ? 'disabled' : null, 'data-focus-key': `trend:${trend.topic}` },
                // A tap runs a refresh about the topic (same post cap as Refresh) and shows the matches in Main as they land.
                on: { click: () => { if (state.busy) { return; } state.tab = 'main'; state.timelineSearch = trend.topic; void refresh({ topic: trend.topic }); } },
            }, [
                el('span', { className: 'sbtw-trend-topic', text: trend.topic }),
                el('span', { className: 'sbtw-trend-count', text: `${formatCount(trend.posts)} posts` }),
            ]))
            : [el('span', { className: 'sbtw-hint', text: 'Trending topics appear after the next Refresh.' })]);
    }

    return el('div', {}, [
        tabs,
        trendsBar,
        el('div', { className: 'sbtw-timeline-search-row' }, [search, resultStatus]),
        composer(),
        results,
    ]);
}

function tabButton(label, value) {
    return el('button', {
        className: `sbtw-tab${state.tab === value ? ' sbtw-tab-on' : ''}`,
        text: label,
        attrs: { type: 'button', 'aria-pressed': String(state.tab === value), 'data-focus-key': `timeline-tab:${value}` },
        on: { click: () => { state.tab = value; render(); } },
    });
}

function profileView() {
    const account = accountFor(state.profileKey);
    if (!account) {
        return el('div', { className: 'sbtw-empty', text: 'That account is not around any more.' });
    }
    const me = personaAccount();
    const following = followingKeys();
    const posts = state.feed.posts.filter(post => post.authorKey === account.key).sort((a, b) => b.createdAt - a.createdAt);
    const liked = state.feed.interactions
        .filter(item => item.type === 'like' && item.actorKey === account.key)
        .map(item => state.feed.posts.find(post => post.id === item.postId))
        .filter(Boolean);
    const reposts = state.feed.interactions
        .filter(item => item.type === 'repost' && item.actorKey === account.key)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(item => ({ item, post: state.feed.posts.find(post => post.id === item.postId) }))
        .filter(entry => entry.post);
    const media = posts.filter(post => post.image?.url);

    const follows = state.session?.follows ?? {};
    const followerCount = Object.values(follows).filter(list => list.includes(account.key)).length;
    // Strangers are people the model invented with profiles of their own, so they can be followed too.
    const canFollow = me && account.key !== me.key;

    return el('div', { className: 'sbtw-profile' }, [
        el('div', { className: 'sbtw-profile-head' }, [
            avatarNode(account, 'lg'),
            el('div', { className: 'sbtw-profile-meta' }, [
                el('div', { className: 'sbtw-name sbtw-name-big', text: account.name }),
                el('div', { className: 'sbtw-handle', text: `@${account.handle}` }),
                account.bio ? el('div', { className: 'sbtw-bio', text: account.bio }) : null,
                account.location ? el('div', { className: 'sbtw-location' }, [icon('fa-location-dot'), el('span', { text: account.location })]) : null,
                el('div', { className: 'sbtw-counts', text: `${(follows[account.key] ?? []).length} following  ·  ${plural(followerCount, 'follower')}` }),
            ]),
            el('div', { className: 'sbtw-profile-actions' }, [
                canFollow
                    ? button(following.has(account.key) ? 'Following' : 'Follow',
                        `sbtw-btn ${following.has(account.key) ? 'sbtw-btn-quiet' : 'sbtw-btn-primary'}`,
                        () => toggleFollow(account.key), { focusKey: `follow:${account.key}` })
                    : null,
                account.kind === KIND_CHARACTER
                    ? button('New profile', 'sbtw-btn sbtw-btn-quiet', () => void rewriteProfile(account.key), {
                        iconName: 'fa-wand-magic-sparkles',
                        title: 'Ask the posts connection for a fresh handle, name and bio for this character',
                        disabled: state.busy,
                        focusKey: `rewrite-profile:${account.key}`,
                    })
                    : null,
            ]),
        ]),
        section('Posts', posts.map(post => postNode(post)), 'Nothing posted yet.'),
        section('Reposts', reposts.map(({ item, post }) => postNode(post, item)), 'Nothing reposted yet.'),
        section('Likes', liked.map(post => postNode(post)), 'Nothing liked yet.'),
        section('Media', media.map(post => postNode(post)), 'No pictures yet.'),
    ]);
}

/** Drops the passers-by this timeline keeps bringing back, so the next refresh invents new ones. */
function forgetStrangers() {
    if (state.busy || !state.session) {
        return;
    }
    const sessionId = state.session.id;
    try {
        const cleared = api.clearStrangers(sessionId);
        state.session = api.getSession(sessionId);
        void refreshAccounts(sessionId).then(() => render()).catch((error) => {
            console.error('[Hopper] the account list could not be refreshed', error);
        });
        render();
        toast(cleared
            ? `${cleared === 1 ? 'One stranger' : `${cleared} strangers`} forgotten. The next refresh brings new ones.`
            : 'No strangers to forget yet.', cleared ? 'success' : 'info');
    } catch (error) {
        console.error('[Hopper] strangers could not be cleared', error);
        toast(error?.message || 'The strangers could not be cleared.', 'error');
    }
}

/** Writes the persona profile under the same cancellable session-wide busy state as a refresh. */
async function writePersonaProfile() {
    if (state.busy || !state.session) {
        return;
    }
    const sessionId = state.session.id;
    const { epoch, signal } = freshSignal();
    state.busy = true;
    state.status = 'Writing your profile...';
    render();
    try {
        const profile = await api.generatePersonaProfile(sessionId, { signal });
        if (!isLive(epoch) || state.session?.id !== sessionId) {
            return;
        }
        if (!profile) {
            toast('The model did not return a usable profile. Try again.', 'warning');
            return;
        }
        const current = api.getSession(sessionId);
        state.session = api.updateSession(sessionId, {
            personaProfile: { ...(current?.personaProfile ?? {}), ...profile },
        });
        try {
            await refreshAccounts(sessionId);
        } catch (error) {
            console.error('[Hopper] the saved persona profile could not be refreshed in the account list', error);
        }
        if (!isLive(epoch) || state.session?.id !== sessionId) {
            return;
        }
        toast(`Profile written: ${profile.name} @${profile.handle}`, 'success');
    } catch (error) {
        if (signal.aborted || error?.name === 'AbortError') {
            return;
        }
        console.error('[Hopper] persona profile generation failed', error);
        toast(error?.message || 'The profile could not be written - check your connection settings.', 'error');
    } finally {
        if (isLive(epoch) && state.session?.id === sessionId) {
            state.busy = false;
            state.status = '';
            render();
        }
    }
}

/** Fresh handles, names and bios for every invited character in one request. */
async function rewriteAllProfiles() {
    if (state.busy || !state.session) {
        return;
    }
    const sessionId = state.session.id;
    const { epoch, signal } = freshSignal();
    state.busy = true;
    state.status = 'Writing new profiles...';
    render();
    try {
        const written = await api.regenerateAllProfiles(sessionId, { signal });
        if (!isLive(epoch)) {
            return;
        }
        if (!written) {
            toast('The model did not return usable profiles. Try again.', 'warning');
            return;
        }
        await refreshAccounts(sessionId);
        toast(written === 1 ? 'New profile written.' : `${written} new profiles written.`, 'success');
    } catch (error) {
        if (signal.aborted) {
            return;
        }
        console.error('[Hopper] profile rewrite failed', error);
        toast(error?.message || 'The profiles could not be written - check your connection settings.', 'error');
    } finally {
        if (isLive(epoch)) {
            state.busy = false;
            state.status = '';
            render();
        }
    }
}

/** A fresh handle, name and bio for a character, written by the posts connection; the old handle is ruled out. */
async function rewriteProfile(accountKey) {
    if (state.busy || !state.session) {
        return;
    }
    const sessionId = state.session.id;
    const { epoch, signal } = freshSignal();
    state.busy = true;
    state.status = 'Writing a new profile...';
    render();
    try {
        const profile = await api.regenerateProfile(accountKey, sessionId, { signal });
        if (!isLive(epoch)) {
            return;
        }
        if (!profile) {
            toast('The model did not return a usable profile. Try again.', 'warning');
            return;
        }
        await refreshAccounts(sessionId);
        toast(`New profile: ${profile.name} @${profile.handle}`, 'success');
    } catch (error) {
        if (signal.aborted) {
            return;
        }
        console.error('[Hopper] profile rewrite failed', error);
        toast(error?.message || 'The profile could not be written - check your connection settings.', 'error');
    } finally {
        if (isLive(epoch)) {
            state.busy = false;
            state.status = '';
            render();
        }
    }
}

function section(title, nodes, emptyText) {
    return el('details', { className: 'sbtw-section', attrs: { open: nodes.length ? 'open' : null } }, [
        el('summary', { text: `${title} (${nodes.length})` }),
        nodes.length ? el('div', { className: 'sbtw-list' }, nodes) : el('div', { className: 'sbtw-empty', text: emptyText }),
    ]);
}

function notificationGroups() {
    const me = personaAccount();
    if (!me || !state.feed) {
        return null;
    }
    return buildNotifications({
        posts: state.feed.posts,
        interactions: state.feed.interactions,
        personaKey: me.key,
        personaHandle: me.handle,
        following: state.session?.follows?.[me.key] ?? [],
    });
}

/** Posts and replies wearing a new-dot right now: the same mark, counted for the Home badge. */
/** "1 follower", not "1 followers". */
function plural(count, one, many = `${one}s`) {
    return `${count} ${count === 1 ? one : many}`;
}

function unseenTimeline() {
    if (!state.feed) {
        return 0;
    }
    const posts = state.feed.posts.filter(post => isNewToMe(post, post.authorKey)).length;
    const replies = state.feed.interactions.filter(item => item.type === 'reply' && isNewToMe(item, item.actorKey)).length;
    return posts + replies;
}

function unseenNotifications() {
    const groups = notificationGroups();
    return groups ? countUnseen(groups, state.session?.notificationsSeenAt ?? 0) : 0;
}

function badgeNode(count) {
    return el('span', { className: 'sbtw-badge', text: count > 99 ? '99+' : String(count), attrs: { 'aria-hidden': 'true' } });
}

const NOTIFICATION_TABS = [['likes', 'Likes'], ['replies', 'Replies'], ['posts', 'Posts']];
const NOTIFICATION_VERB = {
    like: 'liked your post',
    repost: 'reposted you',
    vote: 'voted in your poll',
    reply: 'replied to you',
    'comment-reply': 'replied to your comment',
    'comment-like': 'liked your reply',
    'comment-repost': 'reposted your reply',
    mention: 'mentioned you',
    post: 'posted',
};
const NOTIFICATION_EMPTY = {
    likes: 'No likes, reposts or poll votes on your posts or replies yet.',
    replies: 'No replies yet. Post something and run a refresh.',
    posts: 'No mentions yet, and nothing new from the accounts you follow.',
};

function notificationsView() {
    const groups = notificationGroups();
    if (!groups) {
        return el('div', { className: 'sbtw-empty', text: 'Set a persona to get notifications.' });
    }
    // Looking at the view clears the badge; rows newer than the previous visit stay marked until you leave.
    const latest = Object.values(groups).reduce(
        (value, list) => list.reduce((inner, item) => Math.max(inner, item.createdAt), value),
        0,
    );
    if (latest > (state.session.notificationsSeenAt ?? 0)) {
        state.session = api.updateSession(state.session.id, { notificationsSeenAt: latest });
    }
    const isNew = item => item.createdAt > state.notifSeenBefore;

    const tabs = el('div', { className: 'sbtw-tabs' }, NOTIFICATION_TABS.map(([value, label]) => {
        const fresh = groups[value].filter(isNew).length;
        return el('button', {
            className: `sbtw-tab${state.notifTab === value ? ' sbtw-tab-on' : ''}`,
            attrs: {
                type: 'button',
                'aria-pressed': String(state.notifTab === value),
                'aria-label': `${label}, ${groups[value].length} total${fresh ? `, ${fresh} new` : ''}`,
                'data-focus-key': `notification-tab:${value}`,
            },
            on: { click: () => { state.notifTab = value; render(); } },
        }, [el('span', { text: `${label} ${groups[value].length}` }), fresh ? badgeNode(fresh) : null]);
    }));

    const rows = (groups[state.notifTab] ?? groups.likes).slice(0, 50);
    const list = rows.map(item => el('button', {
        className: `sbtw-notification${isNew(item) ? ' sbtw-notification-new' : ''}`,
        attrs: { type: 'button' },
        on: {
            click: () => {
                state.view = 'timeline';
                state.tab = 'main';
                markTimelineVisit();
                state.timelineSearch = '';
                // Only a reply gives you something to answer; everything else just takes you to the post.
                if (item.kind === 'reply' || item.kind === 'comment-reply') {
                    setReplyTarget(item.postId, item.interactionId, { toggle: false });
                } else {
                    state.replyingTo = null;
                    pendingReplyFocus = null;
                    render();
                }
                scrollToNotification(item);
            },
        },
    }, [
        avatarNode(accountFor(item.actorKey) ?? item.actorSnapshot ?? null, 'sm'),
        el('div', { className: 'sbtw-notification-main' }, [
            el('div', { className: 'sbtw-meta' }, [
                el('span', { className: 'sbtw-name', text: nameFor(item.actorKey, item.actorSnapshot) }),
                el('span', { className: 'sbtw-time', text: dateFormat.format(new Date(item.createdAt)) }),
            ]),
            el('div', { className: 'sbtw-body', text: `${NOTIFICATION_VERB[item.kind] ?? 'reacted'}${item.content ? `: ${item.content}` : ''}` }),
        ]),
    ]));

    return el('div', {}, [
        tabs,
        list.length
            ? el('div', { className: 'sbtw-list' }, list)
            : el('div', { className: 'sbtw-empty', text: NOTIFICATION_EMPTY[state.notifTab] ?? NOTIFICATION_EMPTY.likes }),
    ]);
}

// --- settings view --------------------------------------------------------

function field(label, control, hint = '') {
    if (control instanceof Element && control.matches('input, textarea, select, button') && !control.dataset.focusKey) {
        control.dataset.focusKey = `field:${label}`;
    }
    return el('label', { className: 'sbtw-field' }, [
        el('span', { className: 'sbtw-field-label', text: label }),
        control,
        hint ? el('span', { className: 'sbtw-hint', text: hint }) : null,
    ]);
}

function numberInput(value, min, max, onChange) {
    const input = el('input', {
        className: 'sbtw-input sbtw-number',
        attrs: { type: 'number', min: String(min), max: String(max), value: String(value) },
    });
    input.addEventListener('change', () => {
        const number = Number(input.value);
        // A cleared or junk field keeps what was there; Number('') is 0 and would slide under min.
        if (input.value.trim() === '' || !Number.isFinite(number)) {
            input.value = String(value);
            return;
        }
        onChange(number);
    });
    return input;
}

function checkbox(label, checked, onChange, visual = null) {
    const box = el('input', { attrs: { type: 'checkbox', checked: checked ? 'checked' : null, 'data-focus-key': `check:${label}` } });
    box.checked = checked;
    box.addEventListener('change', () => onChange(box.checked));
    return el('label', { className: 'sbtw-check' }, [box, visual, el('span', { text: label })]);
}

function settingsView() {
    const settings = api.getSettings();
    const context = globalThis.SillyTavern.getContext();
    const session = state.session;
    const characters = context.characters ?? [];
    const profiles = api.listConnectionProfiles();
    const profileAvailable = !settings.profileId || profiles.some(profile => profile.id === settings.profileId);
    const personas = api.listPersonas();
    const notes = api.getScenarioNotes(session.personaId);
    const groups = (context.groups ?? []).filter(group => Array.isArray(group.members) && group.members.length);

    const refreshSettings = () => {
        void refreshAccounts(session.id)
            .then(current => { if (current) { render(); } })
            .catch(error => {
                console.error('[Hopper] settings could not refresh the account list', error);
                toast('The account list could not be refreshed.', 'error');
            });
    };
    const save = (patch) => { api.updateSettings(patch); refreshSettings(); };
    const savePart = (name, patch) => save({ [name]: { ...api.getSettings()[name], ...patch } });
    const saveSession = (patch) => {
        const updated = api.updateSession(session.id, patch);
        if (state.session?.id === session.id) {
            state.session = updated;
        }
        refreshSettings();
    };
    const saveProfile = patch => saveSession({
        personaProfile: { ...(api.getSession(session.id)?.personaProfile ?? {}), ...patch },
    });

    const personaSelect = el('select', {
        className: 'sbtw-input',
        on: {
            change: event => void switchSession(session.id, { personaId: event.target.value }),
        },
    }, personas.map(persona => el('option', {
        text: persona.name,
        attrs: { value: persona.entityId, selected: persona.entityId === session.personaId ? 'selected' : null },
    })));

    const groupSelect = el('select', {
        className: 'sbtw-input',
        on: {
            change: (event) => {
                const group = groups.find(item => String(item.id) === event.target.value);
                if (group) {
                    setInvited(group.members);
                }
            },
        },
    }, [
        el('option', { text: 'Choose a group...', attrs: { value: '' } }),
        ...groups.map(group => el('option', { text: group.name || 'Unnamed group', attrs: { value: String(group.id) } })),
    ]);

    const profileSelect = el('select', {
        className: 'sbtw-input',
        on: { change: (event) => save({ profileId: event.target.value }) },
    }, [
        el('option', { text: profiles.length ? 'Use the current connection' : 'Connection Manager is off', attrs: { value: '', selected: !settings.profileId ? 'selected' : null } }),
        !profileAvailable
            ? el('option', { text: 'Selected connection profile is unavailable', attrs: { value: settings.profileId, selected: 'selected', disabled: 'disabled' } })
            : null,
        ...profiles.map(profile => el('option', {
            text: profile.name,
            attrs: { value: profile.id, selected: profile.id === settings.profileId ? 'selected' : null },
        })),
    ]);

    // Invites change in place. A full re-render would rebuild the scroller under the
    // finger, dropping the reader's place and the focused checkbox; nothing else on this
    // view depends on the invite list, and the account roster refreshes quietly behind it.
    const setInvited = (next) => {
        const updated = api.updateSession(session.id, { invited: [...new Set(next)] });
        if (state.session?.id === session.id) {
            state.session = updated;
        }
        for (const row of inviteRows) {
            row.querySelector('input').checked = updated.invited.includes(row.dataset.avatar);
        }
        filterInvites();
        void refreshAccounts(session.id).catch((error) => {
            console.error('[Hopper] settings could not refresh the account list', error);
            toast('The account list could not be refreshed.', 'error');
        });
    };
    const tagNames = new Map((context.tags ?? []).map(tag => [tag.id, tag.name]));
    const tagsOf = avatar => (context.tagMap?.[avatar] ?? []).map(id => tagNames.get(id)).filter(Boolean);
    const inviteRows = characters.filter(character => character?.avatar).map((character) => {
        const name = character.name || character.data?.name || character.avatar;
        const row = checkbox(
            name,
            session.invited.includes(character.avatar),
            (checked) => {
                const invited = api.getSession(session.id).invited;
                setInvited(checked ? [...invited, character.avatar] : invited.filter(item => item !== character.avatar));
            },
            avatarNode({ kind: KIND_CHARACTER, entityId: character.avatar, name }, 'sm'),
        );
        row.classList.add('sbtw-invite');
        row.dataset.avatar = character.avatar;
        row.dataset.search = [name, character.avatar, ...tagsOf(character.avatar)].join(' ').toLocaleLowerCase();
        return row;
    });
    const inviteCount = el('span', { className: 'sbtw-invite-count' });
    const clearInvites = button('Clear invites', 'sbtw-btn sbtw-btn-quiet', () => setInvited([]), { title: 'Uninvite everyone' });
    const inviteEmpty = el('p', { className: 'sbtw-invite-empty' });
    const invites = el('div', { className: 'sbtw-invites' }, [...inviteRows, inviteEmpty]);
    const inviteSearch = el('input', {
        className: 'sbtw-input sbtw-character-search',
        attrs: {
            type: 'search',
            value: state.characterSearch,
            placeholder: 'Search characters or tags',
            autocomplete: 'off',
            'aria-label': 'Search characters or tags',
            'data-focus-key': 'character-search',
        },
    });
    const filterInvites = () => {
        const query = inviteSearch.value.trim().toLocaleLowerCase();
        let visible = 0;
        for (const row of inviteRows) {
            const hidden = Boolean(query) && !row.dataset.search.includes(query);
            if (row.hidden !== hidden) {
                row.hidden = hidden;
            }
            visible += hidden ? 0 : 1;
        }
        inviteEmpty.hidden = visible > 0;
        inviteEmpty.textContent = query ? 'No characters match this search.' : 'No characters are available.';
        const invitedCount = (api.getSession(session.id) ?? session).invited.length;
        inviteCount.textContent = query ? `${visible} of ${inviteRows.length}` : `${invitedCount} invited`;
        clearInvites.disabled = !invitedCount;
    };
    let searchTimer = null;
    inviteSearch.addEventListener('input', () => {
        state.characterSearch = inviteSearch.value;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(filterInvites, SEARCH_DEBOUNCE_MS);
    });
    filterInvites();

    const activeMode = el('select', {
        className: 'sbtw-input',
        on: { change: (event) => savePart('active', { mode: event.target.value }) },
    }, ['range', 'exact', 'all'].map(mode => el('option', {
        text: { range: 'A random number each time', exact: 'Always the same number', all: 'Everyone invited' }[mode],
        attrs: { value: mode, selected: mode === settings.active.mode ? 'selected' : null },
    })));

    return el('div', { className: 'sbtw-settings' }, [
        el('h3', { text: 'Timeline identity' }),
        el('div', { className: 'sbtw-row' }, [
            field('Timeline name', el('input', {
                className: 'sbtw-input',
                attrs: { type: 'text', value: session.name, maxlength: '80' },
                on: { change: event => saveSession({ name: event.target.value }) },
            })),
            field('Timeline type', el('input', {
                className: 'sbtw-input',
                attrs: { type: 'text', value: session.type, maxlength: '120', placeholder: 'Open timeline' },
                on: { change: event => saveSession({ type: event.target.value }) },
            }), 'Examples: close friends, newsroom, fandom, public figures.'),
        ]),
        field('Persona', personaSelect, 'The selected persona owns this timeline and all activity you make in it.'),
        notes.length ? el('div', {
            className: 'sbtw-field',
            attrs: { role: 'group', 'aria-labelledby': 'sbtw-scenario-notes-label' },
        }, [
            el('span', { className: 'sbtw-field-label', text: 'Scenario Notes', attrs: { id: 'sbtw-scenario-notes-label' } }),
            ...notes.map(note => checkbox(note.name, session.scenarioNoteIds.includes(note.id), checked => {
                const selected = new Set(api.getSession(session.id).scenarioNoteIds);
                if (checked) {
                    selected.add(note.id);
                } else {
                    selected.delete(note.id);
                }
                saveSession({ scenarioNoteIds: [...selected] });
            })),
            el('span', { className: 'sbtw-hint', text: 'Equipped only for this timeline; your host persona settings are not changed.' }),
        ]) : null,

        el('h3', { text: 'Persona profile' }),
        el('div', { className: 'sbtw-composer-bar' }, [
            button(state.status === 'Writing your profile...' ? 'Writing...' : 'Write it with the model', 'sbtw-btn sbtw-btn-quiet', () => void writePersonaProfile(), {
                iconName: 'fa-wand-magic-sparkles',
                title: 'Ask the posts connection to write this profile from your persona description',
                disabled: state.busy,
            }),
            el('span', { className: 'sbtw-hint', text: 'Uses your persona description; you can edit the result.' }),
        ]),
        el('div', { className: 'sbtw-row' }, [
            field('Display name', el('input', {
                className: 'sbtw-input',
                attrs: { type: 'text', value: session.personaProfile.name, maxlength: '120' },
                on: { change: event => saveProfile({ name: event.target.value }) },
            })),
            field('Handle', el('input', {
                className: 'sbtw-input',
                attrs: { type: 'text', value: session.personaProfile.handle, maxlength: '20', placeholder: 'Generated from your name' },
                on: { change: event => saveProfile({ handle: event.target.value }) },
            })),
        ]),
        field('Bio', el('textarea', {
            className: 'sbtw-input',
            attrs: { rows: '3', maxlength: '1000' },
            on: { change: event => saveProfile({ bio: event.target.value }) },
        }, [document.createTextNode(session.personaProfile.bio)])),
        field('Location', el('input', {
            className: 'sbtw-input',
            attrs: { type: 'text', value: session.personaProfile.location, maxlength: '160' },
            on: { change: event => saveProfile({ location: event.target.value }) },
        })),

        el('h3', { text: 'Who posts' }),
        groups.length ? field('Use a host group as this timeline\'s cast', groupSelect, 'This copies the group members; you can then adjust the character list below.') : null,
        // A group of checkboxes cannot live inside a single <label>; each has its own.
        el('div', { className: 'sbtw-field' }, [
            el('div', { className: 'sbtw-field-heading' }, [
                el('span', { className: 'sbtw-field-label', text: 'Characters' }),
                el('span', { className: 'sbtw-field-tools' }, [inviteCount, clearInvites]),
            ]),
            inviteSearch,
            invites,
            el('span', { className: 'sbtw-hint', text: 'Only invited characters take part in a refresh.' }),
        ]),
        el('div', { className: 'sbtw-field' }, [
            el('span', { className: 'sbtw-field-label', text: 'Profiles' }),
            el('div', { className: 'sbtw-button-row' }, [
                button('New profiles for everyone', 'sbtw-btn sbtw-btn-quiet', () => void rewriteAllProfiles(), {
                    iconName: 'fa-wand-magic-sparkles',
                    title: 'Ask the posts connection for a fresh handle, name and bio for every invited character',
                    disabled: state.busy,
                }),
            ]),
            el('span', { className: 'sbtw-hint', text: 'One request rewrites the handle, name and bio of every invited character; the current handles are ruled out. One character at a time: New profile on their page.' }),
        ]),
        checkbox('Let strangers join in', session.ambient, value => saveSession({ ambient: value })),
        el('p', { className: 'sbtw-hint', text: `Random passers-by the model invents, not part of the cast. They mostly reply and like, get a profile, and come back later.${session.strangers.length ? ` ${session.strangers.length} so far.` : ''}` }),
        el('div', { className: 'sbtw-button-row' }, [
            button('Forget these strangers', 'sbtw-btn sbtw-btn-quiet', () => forgetStrangers(), {
                iconName: 'fa-arrows-rotate',
                title: 'Drop the passers-by this timeline keeps bringing back; the next refresh invents new ones',
                disabled: state.busy,
            }),
        ]),
        el('p', { className: 'sbtw-hint', text: 'Their old posts stay as they are. The next refresh introduces a fresh set.' }),
        field('Accounts per refresh', activeMode),
        settings.active.mode === 'range'
            ? el('div', { className: 'sbtw-row' }, [
                field('Fewest', numberInput(settings.active.min, 1, 100, value => savePart('active', { min: value }))),
                field('Most', numberInput(settings.active.max, 1, 100, value => savePart('active', { max: value }))),
            ])
            : null,
        settings.active.mode === 'exact'
            ? field('How many', numberInput(settings.active.count, 1, 100, value => savePart('active', { count: value })))
            : null,

        el('h3', { text: 'Connection' }),
        field('Write posts with', profileSelect, 'A cheap model is fine here. One refresh writes the whole batch, or one activity per request with the option below.'),
        field('Reply budget (tokens)', numberInput(settings.maxTokens, 256, 1000000, value => save({ maxTokens: value })),
            'The most one reply may run to. Thinking models (Kimi, GLM, DeepSeek, Qwen...) spend part of it on their reasoning, and a budget that runs out mid-JSON is a malformed reply - so it is generous. Lower it only if your provider refuses the request.'),

        el('h3', { text: 'How much each refresh makes' }),
        el('div', { className: 'sbtw-row' }, [
            field('Posts', numberInput(settings.quotas.posts, 0, 100, value => savePart('quotas', { posts: value }))),
            field('Replies', numberInput(settings.quotas.replies, 0, 200, value => savePart('quotas', { replies: value }))),
            field('Reposts', numberInput(settings.quotas.reposts, 0, 100, value => savePart('quotas', { reposts: value }))),
            field('Likes', numberInput(settings.quotas.likes, 0, 500, value => savePart('quotas', { likes: value }))),
        ]),
        checkbox('Let accounts make polls', settings.polls, value => save({ polls: value })),
        checkbox('One activity per request', settings.incremental, value => save({ incremental: value })),
        settings.incremental
            ? field('Requests at once', numberInput(settings.concurrency, 1, 6, value => save({ concurrency: value })),
                'Several tiny requests in flight together. Posts land first, then individual replies, reposts, likes and votes. More at once is faster but pricier because every request carries the timeline context.')
            : null,
        el('p', { className: 'sbtw-hint', text: 'Each request returns one post or one reaction in a small JSON object, and the timeline fills in as they land. Posts above is how many.' }),

        el('h3', { text: 'Pictures' }),
        checkbox('Generate images for some posts', settings.images.enabled, value => savePart('images', { enabled: value })),
        settings.images.enabled
            ? field('Images per refresh', numberInput(settings.images.perRefresh, 0, 50, value => savePart('images', { perRefresh: value })),
                'Uses your existing image setup. A failed image just posts the text.')
            : null,
        settings.images.enabled
            ? field('Image directions', el('textarea', {
                className: 'sbtw-input',
                attrs: { rows: '3', maxlength: '4000', placeholder: 'Leave blank for the default.' },
                on: { change: (event) => savePart('images', { instructions: event.target.value }) },
            }, [document.createTextNode(settings.images.instructions)]))
            : null,

        el('h3', { text: 'Voice' }),
        field('Tone instructions', el('textarea', {
            className: 'sbtw-input',
            attrs: { rows: '6', placeholder: 'Leave blank for the default.' },
            on: { change: (event) => save({ tone: event.target.value }) },
        }, [document.createTextNode(settings.tone)]),
        'Only the tone. The rules that keep a refresh parseable are not editable, so you cannot break it from here.'),

        el('h3', { text: 'How much history it reads' }),
        el('div', { className: 'sbtw-row' }, [
            field('Hours back', numberInput(settings.history.hours, 1, 720, value => savePart('history', { hours: value }))),
            field('Posts', numberInput(settings.history.posts, 1, 100, value => savePart('history', { posts: value }))),
            field('Replies per post', numberInput(settings.history.replies, 0, 12, value => savePart('history', { replies: value }))),
        ]),
        el('p', { className: 'sbtw-hint', text: 'What the model is shown of the timeline so far. This is most of every request, and it does not depend on how much a refresh writes - so a long window makes a small refresh just as slow and just as expensive. Raise it for longer memory, lower it for quicker, cheaper refreshes.' }),

        el('h3', { text: 'The chat you have open' }),
        checkbox('Let characters react to the roleplay', settings.scene.enabled, value => savePart('scene', { enabled: value })),
        el('p', { className: 'sbtw-hint', text: 'Sends the last few messages of the chat you have open to this timeline\'s model, so the characters in that scene can post about their own day. Only they may mention it. Off by default: with it on, chat text leaves the chat and goes wherever the connection above points.' }),

        el('h3', { text: 'Feeding it back into chats' }),
        checkbox('Mention recent activity in chats', settings.carry.enabled, value => savePart('carry', { enabled: value })),
        settings.carry.enabled
            ? el('div', { className: 'sbtw-row' }, [
                field('Look back (hours)', numberInput(settings.carry.hours, 1, 720, value => savePart('carry', { hours: value }))),
                field('At most', numberInput(settings.carry.items, 1, 50, value => savePart('carry', { items: value }))),
                field('Depth', numberInput(settings.carry.depth, 0, 100, value => savePart('carry', { depth: value }))),
            ])
            : null,

        el('h3', { text: 'Catching up' }),
        field('Refresh on opening, if this many hours have passed',
            numberInput(settings.catchUpHours, 0, 720, value => save({ catchUpHours: value })),
            'Zero turns it off. Nothing happens while SillyBunny is closed - there is no server side to this.'),

        el('h3', { text: 'Reset or delete' }),
        el('p', { className: 'sbtw-hint', text: 'Reset clears posts, replies, likes, reposts and votes; profiles, follows and settings stay. Delete removes this whole timeline; other timelines and character profiles stay.' }),
        el('div', { className: 'sbtw-button-row' }, [
            button('Reset the timeline', 'sbtw-btn sbtw-btn-danger', () => resetTimeline(), { disabled: state.busy }),
            button('Delete this timeline', 'sbtw-btn sbtw-btn-danger', () => void deleteTimeline(), { iconName: 'fa-trash', disabled: state.busy }),
        ]),
    ]);
}

// --- shell ----------------------------------------------------------------

function navButton(label, iconName, view, { badge = 0 } = {}) {
    return el('button', {
        className: `sbtw-nav-item${state.view === view ? ' sbtw-nav-on' : ''}`,
        // Mobile hides the label span, so the name must live on the button too.
        attrs: { type: 'button', 'aria-label': badge ? `${label}, ${badge} new` : label, 'aria-current': state.view === view ? 'page' : null, 'data-focus-key': `nav:${view}` },
        on: {
            click: () => {
                state.view = view;
                if (view !== 'profile') {
                    state.profileKey = null;
                }
                if (view === 'notifications') {
                    state.notifSeenBefore = state.session?.notificationsSeenAt ?? 0;
                }
                if (view === 'timeline') {
                    markTimelineVisit();
                }
                render();
            },
        },
    }, [
        el('span', { className: 'sbtw-nav-icon' }, [icon(iconName), badge ? badgeNode(badge) : null]),
        el('span', { className: 'sbtw-nav-label', text: label }),
    ]);
}

function whoToFollow() {
    const me = personaAccount();
    if (!me) {
        return null;
    }
    const following = followingKeys();
    const suggestions = state.accounts
        .filter(account => account.kind === KIND_CHARACTER && account.key !== me.key && !following.has(account.key))
        .slice(0, 5);
    if (!suggestions.length) {
        return null;
    }
    return el('aside', { className: 'sbtw-rail' }, [
        el('h4', { text: 'Who to follow' }),
        ...suggestions.map(account => el('div', { className: 'sbtw-suggestion' }, [
            avatarButton(account, 'sm', account.key),
            el('div', { className: 'sbtw-suggestion-meta' }, [
                el('button', { className: 'sbtw-name', text: account.name, attrs: { type: 'button' }, on: { click: () => showProfile(account.key) } }),
                el('span', { className: 'sbtw-handle', text: `@${account.handle}` }),
            ]),
            button('Follow', 'sbtw-btn sbtw-btn-quiet', () => toggleFollow(account.key), { focusKey: `follow:${account.key}` }),
        ])),
    ]);
}

function switchSession(sessionId, options = {}) {
    const targetPersonaId = options.personaId || api.getSession(sessionId)?.personaId || '';
    const changingPersona = targetPersonaId
        && targetPersonaId !== globalThis.SillyTavern.getContext().userAvatar;
    if (!sessionId || (!changingPersona && sessionId === state.session?.id) || sessionTask) {
        return sessionTask ?? Promise.resolve(false);
    }
    const transition = ++transitionEpoch;
    const task = (async () => {
        try {
            invalidateWork();
            await closeFeedInternal(false);
            if (transition !== transitionEpoch) {
                return false;
            }
            pendingPersonaSwitch = changingPersona ? targetPersonaId : '';
            await api.selectSession(sessionId, options);
            if (transition !== transitionEpoch) {
                return false;
            }
            const opened = await openFeedNow();
            return transition === transitionEpoch && opened;
        } catch (error) {
            if (transition !== transitionEpoch) {
                return false;
            }
            console.error('[Hopper] timeline switch failed', error);
            toast(String(error?.message ?? 'That timeline could not be opened.'), 'error');
            return false;
        } finally {
            pendingPersonaSwitch = '';
            if (sessionTask === task) {
                sessionTask = null;
            }
        }
    })();
    sessionTask = task;
    return task;
}

function createTimeline() {
    if (sessionTask) {
        return sessionTask;
    }
    const source = state.session;
    const transition = ++transitionEpoch;
    const task = (async () => {
        try {
            invalidateWork();
            await closeFeedInternal(false);
            if (transition !== transitionEpoch) {
                return false;
            }
            api.createSession({
                personaId: source?.personaId,
                invited: source?.invited,
                ambient: source?.ambient,
            });
            const opened = await openFeedNow();
            if (transition !== transitionEpoch || !opened) {
                return false;
            }
            state.view = 'settings';
            render();
            toast(`New timeline "${state.session?.name ?? 'Timeline'}" - invite characters, then refresh.`, 'info');
            return true;
        } catch (error) {
            if (transition !== transitionEpoch) {
                return false;
            }
            console.error('[Hopper] timeline creation failed', error);
            toast(String(error?.message ?? 'A new timeline could not be created.'), 'error');
            return false;
        } finally {
            if (sessionTask === task) {
                sessionTask = null;
            }
        }
    })();
    sessionTask = task;
    return task;
}

/** Deletes the open timeline (feed file included) and opens the next one for this persona, or a fresh one. */
async function deleteTimeline() {
    if (state.busy || sessionTask || !state.session) {
        return false;
    }
    const session = state.session;
    const context = globalThis.SillyTavern.getContext();
    const confirmed = await context.Popup.show.confirm(
        `Delete "${session.name}"?`,
        'Its posts, replies, reactions, follows and persona profile go for good. Other timelines and character profiles stay.',
    );
    if (!confirmed || state.session !== session || state.busy || sessionTask) {
        return false;
    }
    const transition = ++transitionEpoch;
    const task = (async () => {
        try {
            invalidateWork();
            await closeFeedInternal(false);
            if (transition !== transitionEpoch) {
                return false;
            }
            await api.deleteSession(session.id);
            const opened = await openFeedNow();
            if (transition !== transitionEpoch || !opened) {
                return false;
            }
            toast(`Deleted "${session.name}".`, 'success');
            return true;
        } catch (error) {
            if (transition !== transitionEpoch) {
                return false;
            }
            console.error('[Hopper] timeline delete failed', error);
            toast(String(error?.message ?? 'The timeline could not be deleted.'), 'error');
            await openFeedNow();
            return false;
        } finally {
            if (sessionTask === task) {
                sessionTask = null;
            }
        }
    })();
    sessionTask = task;
    return task;
}

function sessionBar() {
    const personas = new Map(api.listPersonas().map(persona => [persona.entityId, persona.name]));
    const sessions = api.listSessions();
    const select = el('select', {
        className: 'sbtw-input sbtw-session-select',
        attrs: { 'aria-label': 'Timeline session', 'data-focus-key': 'session' },
        on: { change: event => void switchSession(event.target.value) },
    }, sessions.map(session => el('option', {
        text: `${session.name} · ${personas.get(session.personaId) ?? 'Unassigned'}`,
        attrs: { value: session.id, selected: session.id === state.session?.id ? 'selected' : null },
    })));
    return el('div', { className: 'sbtw-session-bar' }, [
        select,
        button('New timeline', 'sbtw-btn sbtw-btn-quiet', () => { void createTimeline(); }, { iconName: 'fa-plus' }),
    ]);
}

function focusedControl(root) {
    const active = document.activeElement;
    const key = active instanceof HTMLElement && root.contains(active) ? active.dataset.focusKey : '';
    if (!key) {
        return null;
    }
    const card = active.closest('[data-post-id], [data-reply-id], [data-repost-id]');
    const scopeSelector = card ? anchorSelector(card) : '';
    const scopeIndex = card ? [...root.querySelectorAll(scopeSelector)].indexOf(card) : 0;
    const scope = card ?? root;
    const matches = [...scope.querySelectorAll(`[data-focus-key="${CSS.escape(key)}"]`)];
    return {
        key,
        index: matches.indexOf(active),
        scope: scopeSelector,
        scopeIndex,
        start: typeof active.selectionStart === 'number' ? active.selectionStart : null,
        end: typeof active.selectionEnd === 'number' ? active.selectionEnd : null,
        direction: active.selectionDirection,
        value: typeof active.selectionStart === 'number' ? active.value : null,
    };
}

function restoreFocusedControl(root, saved) {
    const scope = saved?.scope ? root.querySelectorAll(saved.scope)[saved.scopeIndex] : root;
    const node = scope?.querySelectorAll(`[data-focus-key="${CSS.escape(saved?.key ?? '')}"]`)[saved?.index];
    if (!(node instanceof HTMLElement)) {
        return;
    }
    if (saved.value !== null) {
        node.value = saved.value;
    }
    node.focus({ preventScroll: true });
    if (saved.start !== null && typeof node.setSelectionRange === 'function') {
        node.setSelectionRange(saved.start, saved.end, saved.direction ?? 'none');
    }
}

function render() {
    if (!state.body) {
        return;
    }
    const focus = focusedControl(state.body);
    const oldMain = state.body.querySelector('.sbtw-main');
    const anchor = oldMain?.dataset.scrollKey ? scrollAnchorOf(oldMain) : null;
    if (oldMain?.dataset.scrollKey) {
        scrollPositions.set(oldMain.dataset.scrollKey, oldMain.scrollTop);
    }
    byPost = buildInteractionMap();
    const views = {
        timeline: timelineView,
        profile: profileView,
        notifications: notificationsView,
        settings: settingsView,
    };
    const sessionKey = state.session?.id ?? '';
    const scrollKey = state.view === 'timeline'
        ? `${sessionKey}:timeline:${state.tab}`
        : state.view === 'profile' ? `${sessionKey}:profile:${state.profileKey ?? ''}` : `${sessionKey}:${state.view}`;
    const main = el('main', {
        className: 'sbtw-main',
        attrs: { 'data-scroll-key': scrollKey },
    }, [sessionBar(), (views[state.view] ?? timelineView)()]);
    const me = personaAccount();
    const nav = el('nav', { className: 'sbtw-nav', attrs: { 'aria-label': 'Timeline sections' } }, [
        // The brand mark: the bunny at the head of the nav, a tap back to the top of the timeline.
        el('button', {
            className: 'sbtw-logo',
            attrs: { type: 'button', 'aria-label': 'Hopper', title: 'Hopper - back to the top of the timeline', 'data-focus-key': 'logo' },
            on: { click: () => { state.view = 'timeline'; state.profileKey = null; markTimelineVisit(); render(); const main = state.body?.querySelector('.sbtw-main'); if (main) { main.scrollTop = 0; } } },
        }, [bunnyIcon()]),
        navButton('Home', 'fa-house', 'timeline', { badge: unseenTimeline() }),
        navButton('Notifications', 'fa-bell', 'notifications', { badge: unseenNotifications() }),
        el('button', {
            className: `sbtw-nav-item${state.view === 'profile' ? ' sbtw-nav-on' : ''}`,
            attrs: {
                type: 'button',
                'aria-label': 'Profile',
                'aria-current': state.view === 'profile' ? 'page' : null,
                disabled: me ? null : 'disabled',
                title: me ? 'Profile' : 'Set a persona first',
                'data-focus-key': 'nav:profile',
            },
            on: { click: () => showProfile(me?.key ?? null) },
        }, [el('span', { className: 'sbtw-nav-icon' }, [icon('fa-user')]), el('span', { className: 'sbtw-nav-label', text: 'Profile' })]),
        navButton('Settings', 'fa-gear', 'settings'),
    ]);
    // A rail that does not exist must not be appended - DOM APIs would stringify the null.
    const rail = state.view === 'timeline' ? whoToFollow() : null;
    state.body.replaceChildren(...(rail ? [nav, main, rail] : [nav, main]));
    main.scrollTop = scrollPositions.get(scrollKey) ?? 0;
    if (anchor && oldMain.dataset.scrollKey === scrollKey) {
        pinScrollAnchor(main, anchor);
    }
    restoreFocusedControl(state.body, focus);
}

/**
 * Re-rendering replaces the whole scroller, and a raw scrollTop only survives that when
 * nothing above the reader changed height: a reply box opening or closing, a count
 * widening or an image arriving all move the page under the finger. So remember the
 * innermost post, reply or repost under the top edge and how far down it sat, and put
 * that same item back at that same place after the rebuild.
 */
function scrollAnchorOf(main) {
    const top = main.getBoundingClientRect().top;
    // Probe a little below the edge: a sub-pixel sliver of the item above is not what the
    // reader is looking at, and pinning it would let its own growth push everything down.
    const probe = top + 24;
    let spanning = null;
    let next = null;
    for (const node of main.querySelectorAll('[data-post-id], [data-reply-id], [data-repost-id]')) {
        const rect = node.getBoundingClientRect();
        if (rect.top <= probe && rect.bottom > probe) {
            spanning = node; // descendants come later in document order, so the innermost wins
        } else if (!next && rect.top > probe) {
            next = node;
        }
    }
    const node = spanning ?? next;
    return node ? { selector: anchorSelector(node), offset: node.getBoundingClientRect().top - top } : null;
}

function anchorSelector(node) {
    const own = node.dataset.postId ? `[data-post-id="${CSS.escape(node.dataset.postId)}"]`
        : node.dataset.replyId ? `[data-reply-id="${CSS.escape(node.dataset.replyId)}"]`
            : `[data-repost-id="${CSS.escape(node.dataset.repostId)}"]`;
    // A reply can be on screen twice (under its post and inside a repost of it): scope it to its card.
    const card = node.parentElement?.closest('[data-post-id], [data-repost-id]');
    return card ? `${anchorSelector(card)} ${own}` : own;
}

function pinScrollAnchor(main, anchor) {
    const node = main.querySelector(anchor.selector);
    if (!node) {
        return;
    }
    const delta = node.getBoundingClientRect().top - main.getBoundingClientRect().top - anchor.offset;
    if (delta) {
        main.scrollTop += delta;
    }
}

function scrollToNotification(item) {
    queueMicrotask(() => {
        const composerKey = (item.kind === 'reply' || item.kind === 'comment-reply')
            ? `reply-composer:${replyTargetKey({ postId: item.postId, parentInteractionId: item.interactionId })}`
            : '';
        const composer = composerKey
            ? state.body?.querySelector(`[data-focus-key="${CSS.escape(composerKey)}"]`)
            : null;
        const interaction = item.interactionId
            ? allInteractionsFor(item.postId).find(candidate => candidate.id === item.interactionId)
            : null;
        const targetId = isAnswerable(interaction) ? interaction.id : interaction?.parentInteractionId;
        const target = targetId
            ? state.body?.querySelector(`[data-reply-id="${CSS.escape(targetId)}"], [data-repost-id="${CSS.escape(targetId)}"]`)
            : null;
        (composer ?? target ?? state.body?.querySelector(`[data-post-id="${CSS.escape(item.postId)}"]`))?.scrollIntoView({ block: 'center' });
    });
}

// --- actions --------------------------------------------------------------

async function refreshAccounts(sessionId = state.session?.id) {
    if (!sessionId) {
        return false;
    }
    const request = ++accountRequest;
    const body = state.body;
    const personaId = state.session?.personaId;
    const epoch = sessionEpoch;
    const accounts = await api.currentAccounts(sessionId);
    if (request !== accountRequest
        || state.body !== body
        || state.session?.id !== sessionId
        || state.session?.personaId !== personaId
        || epoch !== sessionEpoch) {
        return false;
    }
    state.accounts = accounts;
    return true;
}

function publish(text) {
    const me = personaAccount();
    const body = String(text ?? '').trim();
    if (!me || (!body && !state.draft.image)) {
        return;
    }
    // A draft left over from a different persona (or before a reopen) is not mine to post.
    const owner = `${state.session.id}:${me.key}`;
    if (state.draftOwner !== owner) {
        state.draft = { text: '', image: '', poll: null };
        state.draftOwner = owner;
        render();
        return;
    }
    const options = api.getSettings().polls
        ? (state.draft.poll ?? []).map(option => option.trim()).filter(Boolean)
        : [];
    const unique = [...new Set(options)];
    if (options.length && unique.length < 2) {
        toast('A poll needs at least two different options.', 'warning');
        return;
    }
    const context = globalThis.SillyTavern.getContext();
    state.feed.posts.push({
        id: context.uuidv4(),
        authorKey: me.key,
        body,
        createdAt: Date.now(),
        image: state.draft.image ? { url: state.draft.image, prompt: '' } : null,
        poll: unique.length >= 2
            ? { question: '', options: unique.slice(0, 4).map((option, index) => ({ id: `option-${index}`, text: option })) }
            : null,
        authorSnapshot: snapshotOf(me),
    });
    state.draft = { text: '', image: '', poll: null };
    state.tab = 'main';
    persist();
    render();
}

function addReply(post, text, parentInteractionId = null) {
    const me = personaAccount();
    if (!me) {
        return;
    }
    const parent = parentInteractionId ? answerableOn(post.id, parentInteractionId) : null;
    if (parentInteractionId && !parent) {
        toast('That reply is no longer available.', 'warning');
        state.replyingTo = null;
        pendingReplyFocus = null;
        render();
        return;
    }
    const context = globalThis.SillyTavern.getContext();
    state.feed.interactions.push({
        id: context.uuidv4(),
        postId: post.id,
        type: 'reply',
        actorKey: me.key,
        content: text,
        parentInteractionId: parent?.id ?? null,
        pollOptionIndex: null,
        createdAt: Date.now(),
        actorSnapshot: snapshotOf(me),
    });
    const target = { postId: post.id, parentInteractionId: parent?.id ?? null };
    state.replyingTo = null;
    replyDrafts.delete(replyTargetKey(target));
    pendingReplyFocus = null;
    persist();
    render();
}

async function deleteReply(reply) {
    const me = personaAccount();
    if (!me || reply.actorKey !== me.key) {
        return;
    }
    const body = state.body;
    const sessionId = state.session?.id;
    const feed = state.feed;
    const context = globalThis.SillyTavern.getContext();
    const confirmed = await context.Popup.show.confirm(
        'Delete this reply?',
        'Replies to it will stay in the conversation.',
    );
    if (!confirmed || state.body !== body || state.session?.id !== sessionId || state.feed !== feed) {
        return;
    }
    const { interactions, ...taken } = removeReply(feed.interactions, reply.id);
    feed.interactions = interactions;
    if (state.replyingTo?.parentInteractionId === reply.id) {
        replyDrafts.delete(replyTargetKey(state.replyingTo));
        state.replyingTo = null;
        pendingReplyFocus = null;
    }
    persist();
    render();
    undoToast('Reply deleted.', () => {
        if (state.body !== body || state.feed !== feed) {
            return;
        }
        feed.interactions = restoreReply(feed.interactions, reply.id, taken);
        persist();
        render();
        focusControl(`delete-reply:${reply.id}`);
    });
}

/** Like or repost a post, or with `reply` that comment itself; a second tap takes it back. */
function toggle(postId, type, reply = null) {
    const me = personaAccount();
    if (!me) {
        return;
    }
    const existing = reply ? (replyStatsFor(postId, reply.id).mine.get(type) ?? null) : myInteraction(postId, type);
    if (existing) {
        state.feed.interactions = state.feed.interactions.filter(item => item !== existing);
    } else {
        const context = globalThis.SillyTavern.getContext();
        state.feed.interactions.push({
            id: context.uuidv4(),
            postId,
            type,
            actorKey: me.key,
            content: null,
            parentInteractionId: reply?.id ?? null,
            pollOptionIndex: null,
            createdAt: Date.now(),
            actorSnapshot: snapshotOf(me),
        });
    }
    persist();
    render();
}

function vote(post, index) {
    const me = personaAccount();
    if (!me) {
        return;
    }
    const existing = myInteraction(post.id, 'vote');
    if (existing) {
        // Changing your mind is allowed; voting twice is not.
        existing.pollOptionIndex = index;
        existing.createdAt = Date.now();
    } else {
        const context = globalThis.SillyTavern.getContext();
        state.feed.interactions.push({
            id: context.uuidv4(),
            postId: post.id,
            type: 'vote',
            actorKey: me.key,
            content: null,
            parentInteractionId: null,
            pollOptionIndex: index,
            createdAt: Date.now(),
            actorSnapshot: snapshotOf(me),
        });
    }
    persist();
    render();
}

async function deletePost(post) {
    const body = state.body;
    const sessionId = state.session?.id;
    const feed = state.feed;
    const context = globalThis.SillyTavern.getContext();
    const confirmed = await context.Popup.show.confirm('Delete this post?', 'Its replies, likes and reposts go too.');
    if (!confirmed || state.body !== body || state.session?.id !== sessionId || state.feed !== feed) {
        return;
    }
    const removed = feed.interactions.filter(item => item.postId === post.id);
    feed.posts = feed.posts.filter(item => item.id !== post.id);
    feed.interactions = feed.interactions.filter(item => item.postId !== post.id);
    persist();
    render();
    undoToast('Post deleted.', () => {
        if (state.body !== body || state.feed !== feed) {
            return;
        }
        feed.posts.push(post);
        feed.interactions.push(...removed);
        persist();
        render();
        focusControl(`delete-post:${post.id}`);
    });
}

function toggleFollow(targetKey) {
    const me = personaAccount();
    if (!me) {
        return;
    }
    // A refresh in flight may have committed follows for other actors since state.session
    // was loaded; merge into the stored session so this tap does not undo them.
    const session = api.getSession(state.session.id) ?? state.session;
    const current = session.follows[me.key] ?? [];
    const next = current.includes(targetKey)
        ? current.filter(key => key !== targetKey)
        : [...current, targetKey];
    state.session = api.updateSession(state.session.id, {
        follows: { ...session.follows, [me.key]: next },
    });
    render();
}

function showProfile(key) {
    if (!key) {
        return;
    }
    state.profileKey = key;
    state.view = 'profile';
    render();
}

async function openImage(url) {
    const context = globalThis.SillyTavern.getContext();
    const image = el('img', { className: 'sbtw-viewer', attrs: { src: url, alt: '' } });
    await new context.Popup(image, context.POPUP_TYPE.DISPLAY, '', { wide: true, large: true }).show();
}

/**
 * A refresh belongs to its session: closing the workspace, resetting the timeline or a newer
 * run aborts it through its signal, and every await is followed by a staleness check so
 * stale work can never render, toast, or clear a live run's state.
 */
async function refresh({ topic = '' } = {}) {
    if (state.busy) {
        return;
    }
    state.busy = true;
    // Whatever is on screen has been seen by the time you ask for more: the badge counts what this refresh brings.
    markTimelineVisit();
    state.status = topic ? `Writing posts about ${topic}...` : 'Thinking...';
    const sessionId = state.session.id;
    const { epoch, signal } = freshSignal();
    let runs = ++refreshRuns;
    // Tallied per committed wave rather than diffed from the feed length: the user keeps
    // posting and deleting while the model writes, and a Stop should count only its work.
    const landed = { posts: 0, reactions: 0 };
    render();
    try {
        const result = await api.runRefresh({
            sessionId,
            feed: state.feed,
            signal,
            topic,
            onProgress: (message) => {
                if (!isLive(epoch)) {
                    return;
                }
                // Progress patches only the status line: a full rerender here would
                // destroy scroll position, focus, and drafts on every image drawn.
                state.status = message;
                const statusNode = state.body?.querySelector('.sbtw-status');
                if (statusNode) {
                    statusNode.textContent = message;
                }
            },
            // One-post-at-a-time mode: each committed post is shown as it lands.
            onPartial: (batch) => {
                landed.posts += batch.posts.length;
                landed.reactions += batch.interactions.length;
                if (isLive(epoch) && state.view === 'timeline') {
                    state.feedEpoch += 1;
                    byPost = buildInteractionMap();
                    render();
                }
            },
        });
        if (!isLive(epoch)) {
            return;
        }
        state.feedEpoch += 1;
        state.session = api.getSession(sessionId);
        await refreshAccounts(sessionId);
        if (!isLive(epoch)) {
            return;
        }
        state.status = '';
        if (result.warnings.length) {
            console.warn('[Hopper] refresh warnings', result.warnings);
        }
        if (!result.posts.length && !result.interactions.length) {
            toast(`The model returned nothing usable this time.${result.warnings.length ? ` ${result.warnings.length} note(s) in the console.` : ''}`, 'warning');
        } else {
            toast(summarizeRefresh(result, { accounts: state.accounts, topic }), 'success');
        }
    } catch (error) {
        if (!isLive(epoch)) {
            console.warn('[Hopper] refresh cancelled', error);
            return;
        }
        state.status = '';
        if (signal.aborted) {
            // Stopped by the user. Everything committed before the stop is already durable and stays.
            state.feedEpoch += 1;
            state.session = api.getSession(sessionId);
            await refreshAccounts(sessionId).catch(cause => console.warn('[Hopper] accounts did not refresh after the stop', cause));
            toast(landed.posts || landed.reactions
                ? `Refresh stopped. ${plural(landed.posts, 'post')} and ${plural(landed.reactions, 'reaction')} that had landed stay.`
                : 'Refresh stopped.', 'info');
            return;
        }
        // Provider errors are remote text; show a fixed message and keep the raw one local.
        console.error('[Hopper] refresh failed', error);
        toast('The refresh failed - check your connection settings, then try again.', 'error');
    } finally {
        if (runs === refreshRuns) {
            state.busy = false;
            state.status = '';
            render();
        }
    }
}

async function resetTimeline() {
    if (state.busy) {
        return;
    }
    const body = state.body;
    const sessionId = state.session?.id;
    const feed = state.feed;
    const context = globalThis.SillyTavern.getContext();
    const confirmed = await context.Popup.show.confirm(
        'Reset the timeline?',
        'Posts, replies, likes, reposts and votes go. Profiles, follows and settings stay.',
    );
    if (!confirmed || state.body !== body || state.session?.id !== sessionId || state.feed !== feed || state.busy) {
        return;
    }
    const cleared = { posts: feed.posts.length, reactions: feed.interactions.length };
    // Kill any generation still running against this timeline before wiping it.
    invalidateWork();
    state.busy = true;
    try {
        await api.writeFeed({ version: 1, posts: [], interactions: [] }, sessionId);
    } catch (error) {
        console.error('[Hopper] resetting the saved feed failed', error);
        toast('The saved timeline could not be reset.', 'error');
        state.busy = false;
        render();
        return;
    }
    if (state.body !== body || state.session?.id !== sessionId || state.feed !== feed) {
        return;
    }
    feed.posts = [];
    feed.interactions = [];
    // A like landed during the write above queued a snapshot of the old feed; replace it
    // with the empty one so the reset cannot be undone by its own autosave.
    api.saveFeedDebounced(feed, 1200, sessionId);
    state.busy = false;
    state.view = 'timeline';
    state.timelineSearch = '';
    state.replyingTo = null;
    replyDrafts.clear();
    render();
    toast(`Timeline reset: ${plural(cleared.posts, 'post')} and ${plural(cleared.reactions, 'reaction')} cleared. Profiles, follows and settings kept.`, 'success');
}

// --- opening --------------------------------------------------------------

function syncLaunchState(open) {
    const launch = document.getElementById(LAUNCH_ID);
    launch?.classList.toggle('is-active', open);
    launch?.setAttribute('aria-pressed', String(open));
}

function closeFeedInternal(cancelTransition, allowExpectedPersonaSwitch = false) {
    const expectedPersonaChange = allowExpectedPersonaSwitch && pendingPersonaSwitch
        && globalThis.SillyTavern.getContext().userAvatar === pendingPersonaSwitch;
    if (cancelTransition && !expectedPersonaChange) {
        transitionEpoch += 1;
    }
    accountRequest += 1;
    const host = document.getElementById('sheld');
    if (!state.body && !openTask && !host?.hasAttribute('data-sbtw-mode')) {
        return closingTask;
    }
    invalidateWork();
    openTask = null;
    refreshRuns += 1;
    uploadToken += 1;
    state.body?.remove();
    state.body = null;
    state.session = null;
    state.feed = null;
    state.accounts = [];
    state.replyingTo = null;
    state.status = '';
    state.busy = false;
    state.draft = { text: '', image: '', poll: null };
    state.draftOwner = null;
    state.timelineSearch = '';
    replyDrafts.clear();
    pendingReplyFocus = null;
    byPost = new Map();
    scrollPositions.clear();
    host?.removeAttribute('data-sbtw-mode');
    syncLaunchState(false);
    const previous = closingTask;
    closingTask = (async () => {
        try {
            await previous;
        } catch {
            // flushFeed below retries any snapshot retained by the failed close.
        }
        await api.flushFeed();
    })();
    void closingTask.catch(error => console.error('[Hopper] final save failed', error));
    return closingTask;
}

export function closeFeed({ cancelTransition = true, allowExpectedPersonaSwitch = false } = {}) {
    return closeFeedInternal(cancelTransition, allowExpectedPersonaSwitch);
}

function handleHostNavigation(event) {
    if (event.target instanceof Element
        && event.target.closest('#sb-home-toggle, #sb_character_mode_toggle [data-sb-character-mode]')) {
        // Restore the host workspace before its own click handler decides what Home means.
        void closeFeed();
    }
}

async function reopenFeed() {
    try {
        await closeFeed();
        return await openFeed();
    } catch (error) {
        console.error('[Hopper] reopening after the final save failed', error);
        toast('The timeline could not be reopened because its latest changes are not saved yet.', 'error');
    }
}

async function waitForClosing() {
    let retried = false;
    while (true) {
        const pending = closingTask;
        try {
            await pending;
        } catch (error) {
            if (pending !== closingTask) {
                continue;
            }
            if (retried) {
                throw error;
            }
            retried = true;
            closingTask = api.flushFeed();
            void closingTask.catch(saveError => console.error('[Hopper] final save retry failed', saveError));
            continue;
        }
        if (pending === closingTask) {
            return;
        }
    }
}

async function openFeedNow() {
    const transition = transitionEpoch;
    await waitForClosing();
    if (transition !== transitionEpoch) {
        return false;
    }
    if (state.body?.isConnected) {
        document.getElementById('sb_character_shell_close')?.click();
        return true;
    }
    if (openTask) {
        return openTask;
    }
    const task = startFeed();
    openTask = task;
    return task.finally(() => {
        if (openTask === task) {
            openTask = null;
        }
    });
}

/** Rapid double-clicks share one load instead of building two workspaces over one state. */
export function openFeed() {
    if (sessionTask) {
        return sessionTask;
    }
    return openFeedNow().catch(error => {
        console.error('[Hopper] opening after the final save failed', error);
        toast('The timeline cannot open until its latest changes are saved.', 'error');
        return false;
    });
}

async function startFeed() {
    const host = document.getElementById('sheld');
    if (!host) {
        toast('The chat workspace is not available yet.', 'warning');
        return false;
    }
    invalidateWork();
    const openingEpoch = sessionEpoch;
    let session = null;
    let feed = null;
    let accounts = [];
    let failure = null;
    try {
        session = api.ensureActiveSession();
    } catch (error) {
        failure = { kind: 'session', error };
    }
    if (!failure) {
        try {
            feed = await api.loadFeed(session.id);
        } catch (error) {
            failure = { kind: 'feed', error };
        }
    }
    if (!failure) {
        try {
            accounts = await api.currentAccounts(session.id);
        } catch (error) {
            failure = { kind: 'accounts', error };
        }
    }
    if (openingEpoch !== sessionEpoch) {
        return false;
    }
    state.session = session;
    state.feed = feed;
    state.accounts = accounts;
    state.view = 'timeline';
    state.tab = 'main';
    markTimelineVisit();
    state.profileKey = null;
    state.replyingTo = null;
    state.timelineSearch = '';
    state.draft = { text: '', image: '', poll: null };
    const owner = accounts.find(account => account.kind === KIND_PERSONA);
    state.draftOwner = session && owner ? `${session.id}:${owner.key}` : null;
    replyDrafts.clear();
    pendingReplyFocus = null;
    scrollPositions.clear();

    const body = el('div', {
        className: `sbtw-shell${failure ? ' sbtw-shell-error' : ''}`,
        attrs: { role: 'region', 'aria-label': 'Hopper' },
    });
    state.body = body;
    window.dispatchEvent(new CustomEvent('sb:close-conversation-workspace'));
    // Conversation Mode also force-closes this panel and does not reopen it on exit.
    document.querySelector('#ica--tracker-panel [data-action="panel-close"]')?.click();
    host.dataset.sbtwMode = 'on';
    host.append(body);
    syncLaunchState(true);
    document.getElementById('sb_character_shell_close')?.click();

    if (failure) {
        const feedFailure = failure.kind === 'feed';
        console.error(`[Hopper] the timeline ${failure.kind} could not be loaded`, failure.error);
        body.append(
            ...(session ? [sessionBar()] : []),
            el('h3', { text: feedFailure ? 'The saved timeline could not be read' : 'The timeline could not be opened' }),
            el('p', { className: 'sbtw-hint', text: String(failure.error?.message ?? failure.error ?? 'Unknown error') }),
            el('div', { className: 'sbtw-composer-bar' }, [
                button('Try again', 'sbtw-btn sbtw-btn-primary', () => reopenFeed()),
                feedFailure ? button('Reset the timeline', 'sbtw-btn sbtw-btn-danger', () => resetFailedTimeline()) : null,
            ]),
        );
        return false;
    } else {
        render();
        if (needsCatchUp(api.getSettings(), Date.now(), state.session)) {
            const last = state.session?.lastRefreshAt ?? 0;
            const hours = Math.round((Date.now() - last) / 3600000);
            toast(last ? `Catching up: it has been ${hours} hours since the last refresh.` : 'Catching up with a first refresh.', 'info');
            void refresh();
        }
        return true;
    }
}

async function resetFailedTimeline() {
    const body = state.body;
    const sessionId = state.session?.id;
    const context = globalThis.SillyTavern.getContext();
    const confirmed = await context.Popup.show.confirm(
        'Start a new timeline?',
        'The saved file will be overwritten with an empty timeline. This cannot be undone.',
    );
    if (!confirmed || !sessionId || state.body !== body || state.session?.id !== sessionId) {
        return;
    }
    try {
        await api.writeFeed({ version: 1, posts: [], interactions: [] }, sessionId);
    } catch (error) {
        console.error('[Hopper] resetting the saved feed failed', error);
        // Say why: a reset that keeps failing silently looks like a reset that does nothing.
        toast(String(error?.message ?? 'The saved file could not be cleared - try again.'), 'error');
        return;
    }
    if (state.body === body) {
        await reopenFeed();
    }
}

// --- mounting -------------------------------------------------------------

function mountCharacterButton() {
    if (document.getElementById(LAUNCH_ID)) {
        return;
    }
    const toggle = document.getElementById('sb_character_mode_toggle');
    if (!toggle?.parentElement) {
        return;
    }
    const node = el('button', {
        className: 'sb-character-shell-mode-button sbtw-launch',
        attrs: {
            id: LAUNCH_ID,
            type: 'button',
            title: 'Open Hopper',
            'aria-label': 'Open Hopper',
            'aria-pressed': 'false',
        },
        on: { click: () => openFeed() },
    }, [bunnyIcon(), el('span', { text: 'Hopper' })]);

    // Keep this outside the radiogroup, then visually place it in the pill with CSS.
    toggle.insertAdjacentElement('afterend', node);
    owned.add(node);
}

function mountWandItem() {
    if (document.getElementById(WAND_ID)) {
        return;
    }
    const menu = document.getElementById('extensionsMenu');
    if (!menu) {
        return;
    }
    // Wand entries must be divs: the host styles #extensionsMenu > div.
    const node = el('div', {
        className: 'list-group-item flex-container flexGap5 interactable',
        attrs: { id: WAND_ID, tabindex: '0', role: 'button', 'aria-label': 'Open Hopper' },
        on: {
            click: () => openFeed(),
            keydown: (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    openFeed();
                }
            },
        },
    }, [
        bunnyIcon('extensionsMenuExtensionButton'),
        el('span', { text: 'Hopper' }),
    ]);
    menu.append(node);
    owned.add(node);
}

function mountDrawer() {
    const host = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!host) {
        return;
    }
    let drawer = document.getElementById(DRAWER_ID);
    if (!drawer) {
        const content = el('div', { className: 'inline-drawer-content', attrs: { id: `${DRAWER_ID}-content` } }, [
            el('p', { className: 'sbtw-hint', text: 'A pretend social timeline for your own cast. Everything lives in the Hopper workspace - open it and use Settings there.' }),
            (() => { const open = button('Open Hopper', 'sbtw-btn sbtw-btn-primary', () => openFeed()); open.prepend(bunnyIcon()); return open; })(),
        ]);
        const toggle = el('div', {
            className: 'inline-drawer-toggle inline-drawer-header',
            attrs: { tabindex: '0', role: 'button', 'aria-expanded': 'false', 'aria-controls': `${DRAWER_ID}-content` },
        }, [
            el('b', { text: 'Hopper' }),
            el('div', { className: 'inline-drawer-icon fa-solid fa-circle-chevron-down down' }),
        ]);
        const onToggle = () => {
            const open = toggle.getAttribute('aria-expanded') === 'true';
            toggle.setAttribute('aria-expanded', String(!open));
        };
        toggle.addEventListener('click', onToggle);
        toggle.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                toggle.click();
            }
        });
        drawer = el('div', {
            className: 'inline-drawer sbtw-drawer',
            attrs: { id: DRAWER_ID, 'data-extension-name': EXTENSION_NAME },
        }, [toggle, content]);
        owned.add(drawer);
    }
    if (drawer.parentElement !== host) {
        host.append(drawer);
    }
}

export function mountAll() {
    document.body.classList.add(BODY_CLASS);
    document.addEventListener('click', handleHostNavigation, true);
    mountCharacterButton();
    mountWandItem();
    mountDrawer();
}

export function unmountAll() {
    document.removeEventListener('click', handleHostNavigation, true);
    removeTrendPanGuard();
    void closeFeed();
    document.body.classList.remove(BODY_CLASS);
    for (const node of owned) {
        node.remove();
    }
    owned.clear();
}
