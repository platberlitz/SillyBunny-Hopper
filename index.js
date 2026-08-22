// Boot and teardown only. Host I/O lives in src/api.js, DOM in src/ui.js, logic in src/core.js.

import { applyCarryover, flushFeed, loadFeed } from './src/api.js';
import { closeFeed, mountAll, unmountAll } from './src/ui.js';

let active = false;
const subscriptions = [];

function ctx() {
    return globalThis.SillyTavern.getContext();
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
    try {
        await applyCarryover(await loadFeed());
    } catch (error) {
        console.error('[Twitlike] could not build the carryover block', error);
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
        subscribe(context.eventTypes.CHAT_CHANGED, () => {
            closeFeed();
            syncCarryover();
        });
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
