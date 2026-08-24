import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');

function block(selector) {
    const start = css.indexOf(`${selector} {`);
    assert.notEqual(start, -1, `${selector} is missing`);
    const end = css.indexOf('}', start);
    assert.notEqual(end, -1, `${selector} has no closing brace`);
    return css.slice(start, end);
}

// A theme's "surface" is regularly translucent (SmartThemeBlurTintColor is a blur tint), which
// made the count see-through over the icon behind it. The chip must carry its own opaque pair.
test('a badge takes its colours from its own fill, not from the theme pairing', () => {
    const badge = block('.sbtw-badge');
    assert.match(badge, /background:\s*var\(--sbtw-accent\)/);
    assert.match(badge, /background:\s*oklch\(from var\(--sbtw-accent\) l c h \/ 1\)/, 'the chip is opaque whatever the accent carries');
    assert.ok(badge.indexOf('background: var(--sbtw-accent)') < badge.indexOf('background: oklch(from'), 'the background fallback stays first');
    assert.match(badge, /color:\s*var\(--sbtw-surface\)/);
    assert.match(badge, /color:\s*oklch\(from var\(--sbtw-accent\)[^;]*\/ 1\)/, 'the text is derived from the chip, black or white by its lightness');
    assert.ok(badge.indexOf('color: var(--sbtw-surface)') < badge.indexOf('color: oklch(from'), 'the theme pair stays first, as the fallback for engines without relative colour');
});

test('the nav ring and the new-post dot stay opaque too', () => {
    const ring = block('.sbtw-nav-icon .sbtw-badge');
    assert.match(ring, /box-shadow:\s*0 0 0 2px var\(--sbtw-nav-surface\)/);
    assert.match(ring, /box-shadow:\s*0 0 0 2px oklch\(from var\(--sbtw-nav-surface\) l c h \/ 1\)/);
    assert.ok(ring.indexOf('box-shadow: 0 0 0 2px var(') < ring.indexOf('box-shadow: 0 0 0 2px oklch('), 'the ring fallback stays first');

    const dot = block('.sbtw-new-dot');
    assert.match(dot, /background:\s*var\(--sbtw-accent\)/);
    assert.match(dot, /background:\s*oklch\(from var\(--sbtw-accent\) l c h \/ 1\)/);
    assert.ok(dot.indexOf('background: var(--sbtw-accent)') < dot.indexOf('background: oklch(from'), 'the dot fallback stays first');
});
