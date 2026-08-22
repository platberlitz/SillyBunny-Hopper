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
    needsCatchUp,
    snapshotOf,
} from './core.js';
import * as api from './api.js';

const LAUNCH_ID = 'sbtw-launch-button';
const WAND_ID = 'sbtw-wand-button';
const DRAWER_ID = 'sbtw-drawer';
const EXTENSION_NAME = 'SillyBunny-TwitterLike';
const FEED_LIMIT = 160;

const state = {
    popup: null,
    body: null,
    feed: null,
    accounts: [],
    view: 'timeline',
    tab: 'main',
    profileKey: null,
    replyingTo: null,
    status: '',
    busy: false,
    draft: { text: '', image: '', poll: null },
    // Persona the current draft belongs to; a draft left by another persona is discarded.
    draftOwner: null,
};

const owned = new Set();
let toggleObserver = null;

// One popup at a time; async work belongs to a session and dies with it.
let openTask = null;
let sessionEpoch = 0;
let workController = null;

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

function button(label, className, onClick, { iconName = '', title = '', pressed = null } = {}) {
    const node = el('button', {
        className,
        attrs: { type: 'button', title: title || label, 'aria-pressed': pressed === null ? null : String(pressed) },
        on: { click: onClick },
    }, iconName ? [icon(iconName), el('span', { text: label })] : [el('span', { text: label })]);
    return node;
}

function toast(message, type = 'info') {
    globalThis.toastr?.[type]?.(message, 'TwitterLike');
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
const EMPTY_STATS = { items: [], like: 0, repost: 0, reply: 0, vote: 0, mine: new Map(), latestReplyAt: 0 };
let byPost = new Map();

function buildInteractionMap() {
    const map = new Map();
    const me = personaAccount();
    for (const item of state.feed.interactions) {
        let entry = map.get(item.postId);
        if (!entry) {
            entry = { items: [], like: 0, repost: 0, reply: 0, vote: 0, mine: new Map(), latestReplyAt: 0 };
            map.set(item.postId, entry);
        }
        entry.items.push(item);
        entry[item.type] += 1;
        if (me && item.actorKey === me.key) {
            entry.mine.set(item.type, item);
        }
        if (item.type === 'reply' && item.createdAt > entry.latestReplyAt) {
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

function countOf(postId, type) {
    return statsFor(postId)[type] ?? 0;
}

function myInteraction(postId, type) {
    return statsFor(postId).mine.get(type) ?? null;
}

/** Only replies bump a conversation; likes and votes must not reorder the timeline. */
function activityAt(post) {
    return Math.max(post.createdAt, statsFor(post.id).latestReplyAt);
}

function followingKeys() {
    const me = personaAccount();
    return new Set(me ? (api.getSettings().follows[me.key] ?? []) : []);
}

function visiblePosts() {
    const sorted = [...state.feed.posts].sort((a, b) => activityAt(b) - activityAt(a));
    if (state.tab === 'following') {
        const following = followingKeys();
        return sorted.filter(post => following.has(post.authorKey)).slice(0, FEED_LIMIT);
    }
    return sorted.slice(0, FEED_LIMIT);
}

function persist() {
    api.saveFeedDebounced(state.feed);
}

// --- rendering ------------------------------------------------------------

function avatarNode(account, size = 'md') {
    const url = account ? api.avatarUrl(account) : '';
    if (url) {
        return el('img', {
            className: `sbtw-avatar sbtw-avatar-${size}`,
            attrs: { src: url, alt: '', loading: 'lazy' },
        });
    }
    const name = account?.name ?? '?';
    const initials = name.split(/\s+/).slice(0, 2).map(part => part[0] ?? '').join('').toUpperCase() || '?';
    // Ambient accounts have no card, so they get a colour derived from their own handle.
    let hash = 0;
    for (const character of account?.handle ?? name) {
        hash = (hash * 31 + character.charCodeAt(0)) % 360;
    }
    const node = el('span', { className: `sbtw-avatar sbtw-avatar-${size} sbtw-avatar-initials`, text: initials });
    node.style.setProperty('--sbtw-avatar-hue', String(hash));
    return node;
}

/** Renders body text as text nodes, turning @handles that match a real account into links. */
function bodyNode(text) {
    const fragment = document.createDocumentFragment();
    const known = handleIndex(state.accounts);
    const pattern = /@([a-z0-9_]{1,20})/gi;
    let cursor = 0;
    for (const match of String(text ?? '').matchAll(pattern)) {
        const account = known.get(match[1].toLowerCase());
        if (!account) {
            continue;
        }
        if (match.index > cursor) {
            fragment.append(document.createTextNode(text.slice(cursor, match.index)));
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

function pollNode(post) {
    if (!post.poll) {
        return null;
    }
    const votes = interactionsFor(post.id).filter(item => item.type === 'vote');
    const mine = myInteraction(post.id, 'vote');
    const total = votes.length;
    const rows = post.poll.options.map((option, index) => {
        const count = votes.filter(vote => vote.pollOptionIndex === index).length;
        const share = total ? Math.round((count / total) * 100) : 0;
        const bar = el('span', { className: 'sbtw-poll-bar' });
        bar.style.setProperty('--sbtw-poll-share', `${share}%`);
        const row = el('button', {
            className: `sbtw-poll-option${mine?.pollOptionIndex === index ? ' sbtw-poll-mine' : ''}`,
            attrs: { type: 'button' },
            on: { click: () => vote(post, index) },
        }, [
            bar,
            el('span', { className: 'sbtw-poll-text', text: option.text }),
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
    return el('button', {
        className: 'sbtw-image',
        attrs: { type: 'button', title: 'Open image' },
        on: { click: () => openImage(post.image.url) },
    }, [el('img', { attrs: { src: post.image.url, alt: post.image.prompt ?? '', loading: 'lazy' } })]);
}

function actionsNode(post) {
    const me = personaAccount();
    const liked = Boolean(myInteraction(post.id, 'like'));
    const reposted = Boolean(myInteraction(post.id, 'repost'));
    const replies = countOf(post.id, 'reply');

    const action = (iconName, count, active, onClick, label) => el('button', {
        className: `sbtw-action${active ? ' sbtw-action-on' : ''}`,
        attrs: { type: 'button', title: label, 'aria-label': label, 'aria-pressed': String(active), disabled: !me },
        on: { click: onClick },
    }, [icon(iconName), el('span', { className: 'sbtw-action-count', text: count > 0 ? String(count) : '' })]);

    return el('div', { className: 'sbtw-actions' }, [
        action('fa-heart', countOf(post.id, 'like'), liked, () => toggle(post, 'like'), liked ? 'Unlike' : 'Like'),
        action('fa-retweet', countOf(post.id, 'repost'), reposted, () => toggle(post, 'repost'), reposted ? 'Undo repost' : 'Repost'),
        action('fa-comment', replies, state.replyingTo === post.id, () => {
            const opening = state.replyingTo !== post.id;
            state.replyingTo = opening ? post.id : null;
            pendingReplyFocus = opening ? post.id : null;
            if (!opening) {
                replyDrafts.delete(post.id);
            }
            render();
        }, 'Reply'),
    ]);
}

function replyNode(reply) {
    const parent = reply.parentInteractionId
        ? state.feed.interactions.find(item => item.id === reply.parentInteractionId)
        : null;
    const account = accountFor(reply.actorKey);
    return el('div', { className: 'sbtw-reply', attrs: { 'data-kind': reply.actorSnapshot?.kind ?? '' } }, [
        avatarNode(account, 'sm'),
        el('div', { className: 'sbtw-reply-main' }, [
            el('div', { className: 'sbtw-meta' }, [
                el('button', {
                    className: 'sbtw-name',
                    text: nameFor(reply.actorKey, reply.actorSnapshot),
                    attrs: { type: 'button' },
                    on: { click: () => showProfile(reply.actorKey) },
                }),
                el('span', { className: 'sbtw-handle', text: `@${handleFor(reply.actorKey, reply.actorSnapshot)}` }),
                el('span', { className: 'sbtw-time', text: dateFormat.format(new Date(reply.createdAt)) }),
            ]),
            parent
                ? el('div', {
                    className: 'sbtw-replying',
                    text: `Replying to @${handleFor(parent.actorKey, parent.actorSnapshot)}`,
                })
                : null,
            el('div', { className: 'sbtw-body' }, [bodyNode(reply.content)]),
        ]),
    ]);
}

function postNode(post) {
    const account = accountFor(post.authorKey);
    const me = personaAccount();
    const mine = me && post.authorKey === me.key;
    const replies = interactionsFor(post.id)
        .filter(item => item.type === 'reply')
        .sort((a, b) => a.createdAt - b.createdAt);

    return el('article', { className: 'sbtw-post', attrs: { 'data-post-id': post.id } }, [
        el('div', { className: 'sbtw-post-row' }, [
            avatarNode(account, 'md'),
            el('div', { className: 'sbtw-post-main' }, [
                el('div', { className: 'sbtw-meta' }, [
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
                            attrs: { type: 'button', title: 'Delete post', 'aria-label': 'Delete post' },
                            on: { click: () => deletePost(post) },
                        }, [icon('fa-ellipsis')])
                        : null,
                ]),
                el('div', { className: 'sbtw-body' }, [bodyNode(post.body)]),
                pollNode(post),
                imageNode(post),
                actionsNode(post),
                state.replyingTo === post.id ? replyComposer(post) : null,
                replies.length ? el('div', { className: 'sbtw-replies' }, replies.map(replyNode)) : null,
            ]),
        ]),
    ]);
}

const replyDrafts = new Map();
let pendingReplyFocus = null;

function replyComposer(post) {
    const me = personaAccount();
    const field = el('textarea', {
        className: 'sbtw-input',
        attrs: {
            rows: '2',
            maxlength: String(REPLY_MAX_CHARS),
            placeholder: `Reply as ${me?.name ?? 'you'}...`,
            'aria-label': `Reply as ${me?.name ?? 'you'}`,
        },
    });
    // The draft survives re-renders; focus is only claimed when the composer opens.
    field.value = replyDrafts.get(post.id) ?? '';
    field.addEventListener('input', () => { replyDrafts.set(post.id, field.value); });
    if (pendingReplyFocus === post.id) {
        pendingReplyFocus = null;
        queueMicrotask(() => field.focus());
    }
    const send = button('Reply', 'sbtw-btn sbtw-btn-primary', () => {
        const text = field.value.trim();
        if (!text) {
            return;
        }
        addReply(post, text);
    });
    return el('div', { className: 'sbtw-reply-composer' }, [field, el('div', { className: 'sbtw-composer-bar' }, [send])]);
}

function composer() {
    const me = personaAccount();
    if (!me) {
        return el('div', { className: 'sbtw-empty', text: 'Set a persona to post. Everything else still works.' });
    }

    const field = el('textarea', {
        className: 'sbtw-input sbtw-composer-input',
        attrs: { rows: '3', maxlength: String(POST_MAX_CHARS), placeholder: "What's happening?", 'aria-label': "What's happening?" },
    });
    field.value = state.draft.text;
    field.addEventListener('input', () => { state.draft.text = field.value; });

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
            attrs: { type: 'text', maxlength: '120', placeholder: `Option ${index + 1}`, value: text },
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
            console.error('[TwitterLike] image upload failed', error);
            toast(error.message, 'error');
        }
    });

    return el('div', { className: 'sbtw-composer' }, [
        el('div', { className: 'sbtw-post-row' }, [
            avatarNode(me, 'md'),
            el('div', { className: 'sbtw-post-main' }, [field, extras]),
        ]),
        el('div', { className: 'sbtw-composer-bar' }, [
            picker,
            button('Image', 'sbtw-btn sbtw-btn-quiet', () => picker.click(), { iconName: 'fa-image' }),
            api.getSettings().polls && !state.draft.poll
                ? button('Poll', 'sbtw-btn sbtw-btn-quiet', () => { state.draft.poll = ['', '']; render(); }, { iconName: 'fa-square-poll-vertical' })
                : null,
            el('span', { className: 'sbtw-spacer' }),
            button('Post', 'sbtw-btn sbtw-btn-primary', () => publish(field.value)),
        ]),
    ]);
}

function timelineView() {
    const posts = visiblePosts();
    // Plain toggle buttons: a real tab pattern needs arrow-key roving focus and
    // tabpanels we do not have, and mislabelled tabs are worse than honest buttons.
    const tabs = el('div', { className: 'sbtw-tabs' }, [
        tabButton('Main', 'main'),
        tabButton('Following', 'following'),
    ]);

    const list = posts.length
        ? el('div', { className: 'sbtw-list' }, posts.map(postNode))
        : el('div', { className: 'sbtw-empty' }, [
            el('p', { text: state.tab === 'following' ? 'Nothing from anyone you follow yet.' : 'Nothing here yet.' }),
            el('p', {
                className: 'sbtw-hint',
                text: state.tab === 'following'
                    ? 'Follow someone from their profile, or from Who to follow.'
                    : 'Invite a character in Settings, then hit Refresh.',
            }),
        ]);

    return el('div', {}, [tabs, composer(), refreshBar(), list]);
}

function tabButton(label, value) {
    return el('button', {
        className: `sbtw-tab${state.tab === value ? ' sbtw-tab-on' : ''}`,
        text: label,
        attrs: { type: 'button', 'aria-pressed': String(state.tab === value) },
        on: { click: () => { state.tab = value; render(); } },
    });
}

function refreshBar() {
    return el('div', { className: 'sbtw-refresh-bar' }, [
        el('button', {
            className: 'sbtw-btn sbtw-btn-primary sbtw-refresh',
            attrs: { type: 'button', disabled: state.busy ? 'disabled' : null },
            on: { click: () => refresh() },
        }, [icon(state.busy ? 'fa-spinner fa-spin' : 'fa-rotate'), el('span', { text: state.busy ? 'Working...' : 'Refresh' })]),
        // Live region: progress updates are announced without stealing focus.
        el('span', {
            className: 'sbtw-status',
            text: state.status,
            attrs: { role: 'status', 'aria-live': 'polite' },
        }),
    ]);
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
    const media = posts.filter(post => post.image?.url);

    const followerCount = Object.values(api.getSettings().follows).filter(list => list.includes(account.key)).length;
    const canFollow = me && account.key !== me.key && account.kind !== KIND_AMBIENT;

    return el('div', { className: 'sbtw-profile' }, [
        el('div', { className: 'sbtw-profile-head' }, [
            avatarNode(account, 'lg'),
            el('div', { className: 'sbtw-profile-meta' }, [
                el('div', { className: 'sbtw-name sbtw-name-big', text: account.name }),
                el('div', { className: 'sbtw-handle', text: `@${account.handle}` }),
                account.bio ? el('div', { className: 'sbtw-bio', text: account.bio }) : null,
                account.location ? el('div', { className: 'sbtw-location' }, [icon('fa-location-dot'), el('span', { text: account.location })]) : null,
                el('div', { className: 'sbtw-counts', text: `${(api.getSettings().follows[account.key] ?? []).length} following  ·  ${followerCount} followers` }),
            ]),
            canFollow
                ? button(following.has(account.key) ? 'Following' : 'Follow',
                    `sbtw-btn ${following.has(account.key) ? 'sbtw-btn-quiet' : 'sbtw-btn-primary'}`,
                    () => toggleFollow(account.key))
                : null,
        ]),
        section('Posts', posts.map(postNode), 'Nothing posted yet.'),
        section('Likes', liked.map(postNode), 'Nothing liked yet.'),
        section('Media', media.map(postNode), 'No pictures yet.'),
    ]);
}

function section(title, nodes, emptyText) {
    return el('details', { className: 'sbtw-section', attrs: { open: nodes.length ? 'open' : null } }, [
        el('summary', { text: `${title} (${nodes.length})` }),
        nodes.length ? el('div', { className: 'sbtw-list' }, nodes) : el('div', { className: 'sbtw-empty', text: emptyText }),
    ]);
}

function notificationsView() {
    const me = personaAccount();
    if (!me) {
        return el('div', { className: 'sbtw-empty', text: 'Set a persona to get notifications.' });
    }
    const myPostIds = new Set(state.feed.posts.filter(post => post.authorKey === me.key).map(post => post.id));
    // Replies to MY comments on other people's posts are notifications too.
    const myReplyIds = new Set(
        state.feed.interactions
            .filter(item => item.type === 'reply' && item.actorKey === me.key && myPostIds.has(item.postId))
            .map(item => item.id),
    );
    const rows = state.feed.interactions
        .filter(item => item.actorKey !== me.key
            && (myPostIds.has(item.postId) || (item.parentInteractionId && myReplyIds.has(item.parentInteractionId))))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 50);

    const verb = { like: 'liked your post', repost: 'reposted you', reply: 'replied to you', vote: 'voted in your poll' };
    const list = rows.map(item => el('button', {
        className: 'sbtw-notification',
        attrs: { type: 'button' },
        on: {
            click: () => {
                state.view = 'timeline';
                // Only a reply gives you something to answer; likes just take you to the post.
                state.replyingTo = item.type === 'reply' ? item.postId : null;
                pendingReplyFocus = null;
                render();
                scrollToPost(item.postId);
            },
        },
    }, [
        avatarNode(accountFor(item.actorKey), 'sm'),
        el('div', {}, [
            el('div', { className: 'sbtw-meta' }, [
                el('span', { className: 'sbtw-name', text: nameFor(item.actorKey, item.actorSnapshot) }),
                el('span', { className: 'sbtw-time', text: dateFormat.format(new Date(item.createdAt)) }),
            ]),
            el('div', {
                className: 'sbtw-body',
                text: `${item.parentInteractionId && !myPostIds.has(item.postId)
                    ? 'replied to your comment'
                    : verb[item.type] ?? 'reacted'}${item.content ? `: ${item.content}` : ''}`,
            }),
        ]),
    ]));

    return list.length
        ? el('div', { className: 'sbtw-list' }, list)
        : el('div', { className: 'sbtw-empty', text: 'Nothing yet. Post something and run a refresh.' });
}

// --- settings view --------------------------------------------------------

function field(label, control, hint = '') {
    return el('label', { className: 'sbtw-field' }, [
        el('span', { className: 'sbtw-field-label', text: label }),
        control,
        hint ? el('span', { className: 'sbtw-hint', text: hint }) : null,
    ]);
}

function numberInput(value, min, max, onChange) {
    return el('input', {
        className: 'sbtw-input sbtw-number',
        attrs: { type: 'number', min: String(min), max: String(max), value: String(value) },
        on: { change: (event) => onChange(Number(event.target.value)) },
    });
}

function checkbox(label, checked, onChange) {
    const box = el('input', { attrs: { type: 'checkbox', checked: checked ? 'checked' : null } });
    box.checked = checked;
    box.addEventListener('change', () => onChange(box.checked));
    return el('label', { className: 'sbtw-check' }, [box, el('span', { text: label })]);
}

function settingsView() {
    const settings = api.getSettings();
    const characters = globalThis.SillyTavern.getContext().characters ?? [];
    const profiles = api.listConnectionProfiles();

    const save = (patch) => { api.updateSettings(patch); refreshAccounts().then(render); };

    const profileSelect = el('select', {
        className: 'sbtw-input',
        on: { change: (event) => save({ profileId: event.target.value }) },
    }, [
        el('option', { text: profiles.length ? 'Use the current connection' : 'Connection Manager is off', attrs: { value: '' } }),
        ...profiles.map(profile => el('option', {
            text: profile.name,
            attrs: { value: profile.id, selected: profile.id === settings.profileId ? 'selected' : null },
        })),
    ]);

    const invites = el('div', { className: 'sbtw-invites' }, characters.map(character => checkbox(
        character.name || character.avatar,
        settings.invited.includes(character.avatar),
        (checked) => {
            const next = checked
                ? [...settings.invited, character.avatar]
                : settings.invited.filter(item => item !== character.avatar);
            save({ invited: next });
        },
    )));

    const activeMode = el('select', {
        className: 'sbtw-input',
        on: { change: (event) => save({ active: { ...settings.active, mode: event.target.value } }) },
    }, ['range', 'exact', 'all'].map(mode => el('option', {
        text: { range: 'A random number each time', exact: 'Always the same number', all: 'Everyone invited' }[mode],
        attrs: { value: mode, selected: mode === settings.active.mode ? 'selected' : null },
    })));

    return el('div', { className: 'sbtw-settings' }, [
        el('h3', { text: 'Who posts' }),
        // A group of checkboxes cannot live inside a single <label>; each has its own.
        el('div', { className: 'sbtw-field' }, [
            el('span', { className: 'sbtw-field-label', text: 'Characters' }),
            invites,
            el('span', { className: 'sbtw-hint', text: 'Only invited characters take part in a refresh.' }),
        ]),
        checkbox('Include the ambient strangers', settings.ambient, value => save({ ambient: value })),
        field('Accounts per refresh', activeMode),
        settings.active.mode === 'range'
            ? el('div', { className: 'sbtw-row' }, [
                field('Fewest', numberInput(settings.active.min, 1, 100, value => save({ active: { ...settings.active, min: value } }))),
                field('Most', numberInput(settings.active.max, 1, 100, value => save({ active: { ...settings.active, max: value } }))),
            ])
            : null,
        settings.active.mode === 'exact'
            ? field('How many', numberInput(settings.active.count, 1, 100, value => save({ active: { ...settings.active, count: value } })))
            : null,

        el('h3', { text: 'Connection' }),
        field('Write posts with', profileSelect, 'A cheap model is fine here. One refresh writes the whole batch.'),

        el('h3', { text: 'How much each refresh makes' }),
        el('div', { className: 'sbtw-row' }, [
            field('Posts', numberInput(settings.quotas.posts, 0, 100, value => save({ quotas: { ...settings.quotas, posts: value } }))),
            field('Replies', numberInput(settings.quotas.replies, 0, 200, value => save({ quotas: { ...settings.quotas, replies: value } }))),
            field('Reposts', numberInput(settings.quotas.reposts, 0, 100, value => save({ quotas: { ...settings.quotas, reposts: value } }))),
            field('Likes', numberInput(settings.quotas.likes, 0, 500, value => save({ quotas: { ...settings.quotas, likes: value } }))),
        ]),
        checkbox('Let accounts make polls', settings.polls, value => save({ polls: value })),

        el('h3', { text: 'Pictures' }),
        checkbox('Generate images for some posts', settings.images.enabled, value => save({ images: { ...settings.images, enabled: value } })),
        settings.images.enabled
            ? field('Images per refresh', numberInput(settings.images.perRefresh, 0, 50, value => save({ images: { ...settings.images, perRefresh: value } })),
                'Uses your existing image setup. A failed image just posts the text.')
            : null,
        settings.images.enabled
            ? field('Image directions', el('textarea', {
                className: 'sbtw-input',
                attrs: { rows: '3', maxlength: '4000', placeholder: 'Leave blank for the default.' },
                on: { change: (event) => save({ images: { ...settings.images, instructions: event.target.value } }) },
            }, [document.createTextNode(settings.images.instructions)]))
            : null,

        el('h3', { text: 'Voice' }),
        field('Tone instructions', el('textarea', {
            className: 'sbtw-input',
            attrs: { rows: '6', placeholder: 'Leave blank for the default.' },
            on: { change: (event) => save({ tone: event.target.value }) },
        }, [document.createTextNode(settings.tone)]),
        'Only the tone. The rules that keep a refresh parseable are not editable, so you cannot break it from here.'),

        el('h3', { text: 'Feeding it back into chats' }),
        checkbox('Mention recent activity in chats', settings.carry.enabled, value => save({ carry: { ...settings.carry, enabled: value } })),
        settings.carry.enabled
            ? el('div', { className: 'sbtw-row' }, [
                field('Look back (hours)', numberInput(settings.carry.hours, 1, 720, value => save({ carry: { ...settings.carry, hours: value } }))),
                field('At most', numberInput(settings.carry.items, 1, 50, value => save({ carry: { ...settings.carry, items: value } }))),
                field('Depth', numberInput(settings.carry.depth, 0, 100, value => save({ carry: { ...settings.carry, depth: value } }))),
            ])
            : null,

        el('h3', { text: 'Catching up' }),
        field('Refresh on opening, if this many hours have passed',
            numberInput(settings.catchUpHours, 0, 720, value => save({ catchUpHours: value })),
            'Zero turns it off. Nothing happens while SillyBunny is closed - there is no server side to this.'),

        el('h3', { text: 'Reset' }),
        el('p', { className: 'sbtw-hint', text: 'Clears posts, replies, likes, reposts and votes. Profiles, follows and settings stay.' }),
        button('Reset the timeline', 'sbtw-btn sbtw-btn-danger', () => resetTimeline()),
    ]);
}

// --- shell ----------------------------------------------------------------

function navButton(label, iconName, view) {
    return el('button', {
        className: `sbtw-nav-item${state.view === view ? ' sbtw-nav-on' : ''}`,
        // The label span is hidden below 1100px, so the name must live on the button.
        attrs: { type: 'button', 'aria-label': label, 'aria-current': state.view === view ? 'page' : null },
        on: { click: () => { state.view = view; if (view !== 'profile') { state.profileKey = null; } render(); } },
    }, [icon(iconName), el('span', { text: label })]);
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
            avatarNode(account, 'sm'),
            el('div', { className: 'sbtw-suggestion-meta' }, [
                el('button', { className: 'sbtw-name', text: account.name, attrs: { type: 'button' }, on: { click: () => showProfile(account.key) } }),
                el('span', { className: 'sbtw-handle', text: `@${account.handle}` }),
            ]),
            button('Follow', 'sbtw-btn sbtw-btn-quiet', () => toggleFollow(account.key)),
        ])),
    ]);
}

function render() {
    if (!state.body) {
        return;
    }
    byPost = buildInteractionMap();
    const views = {
        timeline: timelineView,
        profile: profileView,
        notifications: notificationsView,
        settings: settingsView,
    };
    const main = el('main', { className: 'sbtw-main' }, [(views[state.view] ?? timelineView)()]);
    const me = personaAccount();
    const nav = el('nav', { className: 'sbtw-nav', attrs: { 'aria-label': 'Timeline sections' } }, [
        navButton('Home', 'fa-house', 'timeline'),
        navButton('Notifications', 'fa-bell', 'notifications'),
        el('button', {
            className: `sbtw-nav-item${state.view === 'profile' ? ' sbtw-nav-on' : ''}`,
            attrs: {
                type: 'button',
                'aria-label': 'Profile',
                'aria-current': state.view === 'profile' ? 'page' : null,
                disabled: me ? null : 'disabled',
                title: me ? 'Profile' : 'Set a persona first',
            },
            on: { click: () => showProfile(me?.key ?? null) },
        }, [icon('fa-user'), el('span', { text: 'Profile' })]),
        navButton('Settings', 'fa-gear', 'settings'),
    ]);
    // A rail that does not exist must not be appended - DOM APIs would stringify the null.
    const rail = state.view === 'timeline' ? whoToFollow() : null;
    state.body.replaceChildren(...(rail ? [nav, main, rail] : [nav, main]));
}

function scrollToPost(postId) {
    queueMicrotask(() => {
        state.body?.querySelector(`[data-post-id="${CSS.escape(postId)}"]`)?.scrollIntoView({ block: 'center' });
    });
}

// --- actions --------------------------------------------------------------

async function refreshAccounts() {
    state.accounts = await api.currentAccounts();
}

function publish(text) {
    const me = personaAccount();
    const body = String(text ?? '').trim();
    if (!me || (!body && !state.draft.image)) {
        return;
    }
    // A draft left over from a different persona (or before a reopen) is not mine to post.
    if (state.draftOwner !== me.key) {
        state.draft = { text: '', image: '', poll: null };
        state.draftOwner = me.key;
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

function addReply(post, text) {
    const me = personaAccount();
    if (!me) {
        return;
    }
    const context = globalThis.SillyTavern.getContext();
    state.feed.interactions.push({
        id: context.uuidv4(),
        postId: post.id,
        type: 'reply',
        actorKey: me.key,
        content: text,
        parentInteractionId: null,
        pollOptionIndex: null,
        createdAt: Date.now(),
        actorSnapshot: snapshotOf(me),
    });
    state.replyingTo = null;
    replyDrafts.delete(post.id);
    pendingReplyFocus = null;
    persist();
    render();
}

function toggle(post, type) {
    const me = personaAccount();
    if (!me) {
        return;
    }
    const existing = myInteraction(post.id, type);
    if (existing) {
        state.feed.interactions = state.feed.interactions.filter(item => item !== existing);
    } else {
        const context = globalThis.SillyTavern.getContext();
        state.feed.interactions.push({
            id: context.uuidv4(),
            postId: post.id,
            type,
            actorKey: me.key,
            content: null,
            parentInteractionId: null,
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
    const context = globalThis.SillyTavern.getContext();
    const confirmed = await context.Popup.show.confirm('Delete this post?', 'Its replies, likes and reposts go too.');
    if (!confirmed) {
        return;
    }
    state.feed.posts = state.feed.posts.filter(item => item.id !== post.id);
    state.feed.interactions = state.feed.interactions.filter(item => item.postId !== post.id);
    persist();
    render();
}

function toggleFollow(targetKey) {
    const me = personaAccount();
    if (!me) {
        return;
    }
    const settings = api.getSettings();
    const current = settings.follows[me.key] ?? [];
    const next = current.includes(targetKey)
        ? current.filter(key => key !== targetKey)
        : [...current, targetKey];
    api.updateSettings({ follows: { ...settings.follows, [me.key]: next } });
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
 * A refresh belongs to its session: closing the popup, resetting the timeline or a newer
 * run aborts it through its signal, and every await is followed by a staleness check so
 * stale work can never render, toast, or clear a live run's state.
 */
async function refresh() {
    if (state.busy) {
        return;
    }
    state.busy = true;
    state.status = 'Thinking...';
    const { epoch, signal } = freshSignal();
    let runs = ++refreshRuns;
    render();
    try {
        const result = await api.runRefresh({
            feed: state.feed,
            signal,
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
        });
        if (!isLive(epoch)) {
            return;
        }
        await refreshAccounts();
        if (!isLive(epoch)) {
            return;
        }
        state.status = '';
        if (result.warnings.length) {
            console.warn('[TwitterLike] refresh warnings', result.warnings);
            toast(`Kept what made sense. ${result.warnings.length} item(s) were dropped - see the console.`, 'info');
        }
        if (!result.posts.length && !result.interactions.length) {
            toast('The model returned nothing usable this time.', 'warning');
        }
    } catch (error) {
        if (!isLive(epoch)) {
            console.warn('[TwitterLike] refresh cancelled', error);
            return;
        }
        state.status = '';
        // Provider errors are remote text; show a fixed message and keep the raw one local.
        console.error('[TwitterLike] refresh failed', error);
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
    const context = globalThis.SillyTavern.getContext();
    const confirmed = await context.Popup.show.confirm(
        'Reset the timeline?',
        'Posts, replies, likes, reposts and votes go. Profiles, follows and settings stay.',
    );
    if (!confirmed) {
        return;
    }
    // Kill any generation still running against this timeline before wiping it.
    invalidateWork();
    state.feed.posts = [];
    state.feed.interactions = [];
    try {
        await api.writeFeed(state.feed);
    } catch (error) {
        console.error('[TwitterLike] resetting the saved feed failed', error);
        toast('The timeline is cleared here, but the saved file could not be rewritten.', 'warning');
    }
    state.view = 'timeline';
    render();
}

// --- opening --------------------------------------------------------------

/**
 * How far down the screen the feed has to start. --topBarBlockSize is the host's own
 * variable, but a theme can restyle the bar without updating it - Moonlit reports 34px for
 * a bar that actually ends at 40 - so measure the thing itself and keep the variable as a
 * fallback for when none of the containers are on the page.
 */
function topbarOffset() {
    let bottom = 0;
    for (const id of ['sb-topbar-stack', 'top-bar', 'top-settings-holder']) {
        const node = document.getElementById(id);
        if (!node) {
            continue;
        }
        const rect = node.getBoundingClientRect();
        if (rect.height > 0 && rect.bottom > bottom) {
            bottom = rect.bottom;
        }
    }
    return Math.round(bottom);
}

function applyTopbarOffset() {
    const dialog = state.popup?.dlg;
    if (!dialog) {
        return;
    }
    const offset = topbarOffset();
    if (offset > 0) {
        dialog.style.setProperty('--sbtw-topbar', `${offset}px`);
    } else {
        dialog.style.removeProperty('--sbtw-topbar');
    }
}

function closePopup(popup) {
    if (typeof popup.completeCancelled === 'function') {
        popup.completeCancelled();
    } else {
        popup.hide?.();
    }
}

/** Waits out the closing session so a retry starts against clean state. */
async function reopenFeed() {
    while (openTask) {
        try {
            await openTask;
        } catch {
            // The failed attempt already reported itself.
        }
    }
    openFeed();
}

/**
 * One feed at a time: rapid double-clicks share the same promise instead of building two
 * popups over one set of globals.
 */
export function openFeed() {
    if (openTask) {
        return openTask;
    }
    openTask = startFeed().finally(() => { openTask = null; });
    return openTask;
}

async function startFeed() {
    const context = globalThis.SillyTavern.getContext();
    invalidateWork();
    let failure = null;
    try {
        state.feed = await api.loadFeed();
        await refreshAccounts();
    } catch (error) {
        state.feed = null;
        failure = error;
    }
    state.view = 'timeline';
    state.replyingTo = null;
    state.draft = { text: '', image: '', poll: null };
    state.draftOwner = null;
    replyDrafts.clear();
    pendingReplyFocus = null;

    const body = el('div', { className: 'sbtw-shell', attrs: { role: 'region', 'aria-label': 'TwitterLike' } });
    if (failure) {
        // Fail closed with a way out - never an editable-looking empty timeline.
        console.error('[TwitterLike] the saved timeline could not be opened', failure);
        body.append(
            el('h3', { text: 'The saved timeline could not be read' }),
            el('p', { className: 'sbtw-hint', text: String(failure?.message ?? failure) }),
            el('div', { className: 'sbtw-composer-bar' }, [
                button('Try again', 'sbtw-btn sbtw-btn-primary', () => { closePopup(popup); reopenFeed(); }),
                button('Reset the timeline', 'sbtw-btn sbtw-btn-danger', () => resetFailedTimeline(popup)),
            ]),
        );
    } else {
        state.body = body;
        render();
        if (needsCatchUp(api.getSettings())) {
            refresh();
        }
    }

    // Full screen below the top bar. The host has no fullscreen popup option, so the size
    // comes from our own class on the dialog rather than from wide/large.
    const popup = new context.Popup(body, context.POPUP_TYPE.DISPLAY, '', {
        animation: 'fast',
    });
    popup.dlg?.classList.add('sbtw-popup');
    state.popup = popup;
    applyTopbarOffset();
    window.addEventListener('resize', applyTopbarOffset);

    try {
        await popup.show();
    } finally {
        window.removeEventListener('resize', applyTopbarOffset);
        invalidateWork();
        if (state.popup === popup) {
            state.popup = null;
            state.body = null;
            byPost = new Map();
        }
        await api.flushFeed().catch(error => console.error('[TwitterLike] final save failed', error));
    }
}

async function resetFailedTimeline(popup) {
    const context = globalThis.SillyTavern.getContext();
    const confirmed = await context.Popup.show.confirm(
        'Start a new timeline?',
        'The saved file will be overwritten with an empty timeline. This cannot be undone.',
    );
    if (!confirmed) {
        return;
    }
    try {
        await api.writeFeed({ version: 1, posts: [], interactions: [] });
    } catch (error) {
        console.error('[TwitterLike] resetting the saved feed failed', error);
        toast('The saved file could not be cleared - try again.', 'error');
        return;
    }
    closePopup(popup);
    reopenFeed();
}

// --- mounting -------------------------------------------------------------

/**
 * The launch button sits in the Character Menu header, beside the Roleplay/Conversation
 * picker. That picker is a `role="radiogroup"`, so the button goes next to it as a sibling
 * and never inside it - a non-radio child would break the group's semantics.
 *
 * Both the picker and the close button are absolutely positioned against the header, so
 * ours is too. Its `right` has to clear the picker, whose width changes when its labels
 * are hidden below 900px, hence the observer rather than a fixed offset.
 */
const LAUNCH_GAP = 8;

function positionLaunchButton() {
    const toggle = document.getElementById('sb_character_mode_toggle');
    const node = document.getElementById(LAUNCH_ID);
    const header = toggle?.parentElement;
    if (!toggle || !node || !header) {
        return;
    }
    const box = toggle.getBoundingClientRect();
    if (box.width <= 0) {
        // Panel is closed or mid-open; the numbers would be meaningless.
        return;
    }
    const frame = header.getBoundingClientRect();
    // Derive everything from the picker itself. Its top, right offset and height all change
    // across breakpoints, so hardcoding any of them just moves the bug to another width.
    node.style.setProperty('--sbtw-launch-top', `${Math.round(box.top - frame.top)}px`);
    node.style.setProperty('--sbtw-launch-right', `${Math.round(frame.right - box.left + LAUNCH_GAP)}px`);
    node.style.setProperty('--sbtw-launch-size', `${Math.round(box.height)}px`);
}

function mountCharacterButton() {
    if (document.getElementById(LAUNCH_ID)) {
        positionLaunchButton();
        return;
    }
    const toggle = document.getElementById('sb_character_mode_toggle');
    const header = toggle?.parentElement;
    if (!header) {
        return;
    }
    const node = el('button', {
        className: 'sbtw-launch',
        attrs: {
            id: LAUNCH_ID,
            type: 'button',
            title: 'TwitterLike',
            'aria-label': 'Open TwitterLike',
        },
        on: { click: () => openFeed() },
    }, [icon('fa-hashtag')]);

    toggle.insertAdjacentElement('beforebegin', node);
    owned.add(node);
    positionLaunchButton();

    /*
     * Measuring once is not enough. The panel animates open, and observing only the picker
     * catches a mid-animation width (238px for a picker that settles at 248) with no
     * further callback. So watch the panel as well, and re-measure when its open/close
     * transition ends - between them the button is never left at a stale offset.
     */
    const panel = node.closest('#right-nav-panel') ?? node.closest('.drawer-content');
    if (typeof ResizeObserver === 'function') {
        toggleObserver?.disconnect();
        toggleObserver = new ResizeObserver(() => positionLaunchButton());
        toggleObserver.observe(toggle);
        if (panel) {
            toggleObserver.observe(panel);
        }
    }
    if (panel && !panel.dataset.sbtwPositionBound) {
        panel.dataset.sbtwPositionBound = 'true';
        panel.addEventListener('transitionend', positionLaunchButton);
    }
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
        attrs: { id: WAND_ID, tabindex: '0', role: 'button', 'aria-label': 'Open TwitterLike' },
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
        el('div', { className: 'fa-solid fa-hashtag extensionsMenuExtensionButton' }),
        el('span', { text: 'TwitterLike' }),
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
            el('p', { className: 'sbtw-hint', text: 'A pretend social timeline for your own cast. Everything lives in the feed window - open it and use Settings there.' }),
            button('Open TwitterLike', 'sbtw-btn sbtw-btn-primary', () => openFeed(), { iconName: 'fa-hashtag' }),
        ]);
        const toggle = el('div', {
            className: 'inline-drawer-toggle inline-drawer-header',
            attrs: { tabindex: '0', role: 'button', 'aria-expanded': 'false', 'aria-controls': `${DRAWER_ID}-content` },
        }, [
            el('b', { text: 'TwitterLike' }),
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
    mountCharacterButton();
    mountWandItem();
    mountDrawer();
}

export function unmountAll() {
    document.body.classList.remove(BODY_CLASS);
    toggleObserver?.disconnect();
    toggleObserver = null;
    for (const node of owned) {
        node.remove();
    }
    owned.clear();
    invalidateWork();
    state.popup?.completeCancelled?.();
    state.popup = null;
    state.body = null;
    state.feed = null;
    state.accounts = [];
    byPost = new Map();
}
