// Boot and teardown only. Host I/O lives in src/api.js, DOM in src/ui.js, logic in src/core.js.

import { assertCapabilities, applyCarryover, flushFeed, loadFeed } from './src/api.js';
import { mountAll, unmountAll } from './src/ui.js';

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
        console.error('[TwitterLike] could not build the carryover block', error);
    }
}

function start() {
    if (active) {
        return;
    }
    const context = assertCapabilities();
    active = true;

    try {
        subscribe(context.eventTypes.APP_READY, () => mountAll());
        subscribe(context.eventTypes.CHAT_CHANGED, () => { syncCarryover(); });
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
        console.error('[TwitterLike] teardown had a problem', error);
    }
    flushFeed().catch(error => console.error('[TwitterLike] final save failed', error));
    unmountAll();
}

export function activate() {
    start();
}

export function enable() {
    start();
}

export function disable() {
    stop();
}

start();
