// Boot and teardown only. Host I/O lives in src/api.js, DOM in src/ui.js, logic in src/core.js.

import { applyCarryover, clearCarryover, ensureActiveSession, flushFeed, getSettings, loadFeed } from './src/api.js';
import { closeFeed, mountAll, unmountAll } from './src/ui.js';

let active = false;
let carryoverEpoch = 0;
const subscriptions = [];

function ctx() {
    return globalThis.SillyTavern.getContext();
}

function contextIdentity(sessionId) {
    const context = ctx();
    return [sessionId, getSettings().activeSessionId, context.userAvatar, context.chatId, context.characterId, context.groupId]
        .map(value => String(value ?? ''))
        .join('\u0000');
}

function subscribe(eventType, handler) {
    if (!eventType) {
        return;
    }
    ctx().eventSource.on(eventType, handler);
    subscriptions.push({ eventType, handler });
}

function unsubscribeAll() {
    const context = ctx();
    for (const { eventType, handler } of subscriptions.splice(0)) {
        context.eventSource.removeListener?.(eventType, handler);
    }
}

/**
 * Rebuilds the carryover block before a generation. It is opt-in and clears itself when it
 * has nothing to say, so a disabled or empty feed never leaves a stale block in the prompt.
 */
async function syncCarryover() {
    if (!active) {
        return;
    }
    const epoch = ++carryoverEpoch;
    let sessionId = '';
    let identity = contextIdentity(sessionId);
    const isCurrent = () => active
        && epoch === carryoverEpoch
        && identity === contextIdentity(sessionId);
    try {
        const session = ensureActiveSession();
        sessionId = session.id;
        identity = contextIdentity(sessionId);
        await flushFeed(sessionId);
        if (!isCurrent()) {
            return;
        }
        const feed = await loadFeed(sessionId);
        await applyCarryover(feed, sessionId, { isCurrent });
    } catch (error) {
        if (isCurrent()) {
            clearCarryover();
            console.error('[Twitlike] could not build the carryover block', error);
        }
    }
}

async function closeAndSyncCarryover(closeOptions) {
    if (!active) {
        return;
    }
    try {
        await closeFeed(closeOptions);
    } catch (error) {
        clearCarryover();
        console.error('[Twitlike] could not save the timeline before changing context', error);
        return;
    }
    if (active) {
        await syncCarryover();
    }
}

function start() {
    if (active) {
        return;
    }
    // Host compatibility is guaranteed by the manifest's minimum version, not by
    // probing individual APIs; optional features check at their point of use.
    const context = ctx();
    active = true;

    try {
        subscribe(context.eventTypes.APP_READY, () => mountAll());
        subscribe(context.eventTypes.CHAT_CHANGED, () => closeAndSyncCarryover());
        subscribe(context.eventTypes.PERSONA_CHANGED, () => closeAndSyncCarryover({ allowExpectedPersonaSwitch: true }));
        subscribe(context.eventTypes.PERSONA_UPDATED, () => syncCarryover());
        subscribe(context.eventTypes.GENERATION_AFTER_COMMANDS, () => syncCarryover());

        // APP_READY is sticky in the host, but enabling after load still needs a direct mount.
        if (document.getElementById('send_form')) {
            mountAll();
            syncCarryover();
        }
    } catch (error) {
        active = false;
        unsubscribeAll();
        throw error;
    }
}

function stop() {
    if (!active) {
        return;
    }
    active = false;
    carryoverEpoch += 1;
    try {
        unsubscribeAll();
        ctx().setExtensionPrompt('SillyBunny-TwitterLike', '', 1, 1, false, 0);
    } catch (error) {
        console.error('[Twitlike] teardown had a problem', error);
    }
    const finalSave = flushFeed().catch(error => console.error('[Twitlike] final save failed', error));
    unmountAll();
    // The host may or may not await disable(), but nothing is left dangling either way.
    return finalSave;
}

export function activate() {
    start();
}

export function enable() {
    start();
}

export function disable() {
    return stop();
}

start();
