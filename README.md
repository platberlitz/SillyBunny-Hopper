# SillyBunny Hopper

A pretend social timeline for a SillyBunny cast. Each timeline belongs to a persona and has its own profiles, invited characters, follows and history. One **Refresh** asks the model for a batch of posts and reactions; posting, replying, liking, polls and pictures are done by hand.

![Hopper sits in the Character Menu next to Roleplay and Conversation](screenshots/launch.png)

![Hopper: the Main timeline with posts and threaded replies](screenshots/timeline.png)

| A stranger's profile (invented by the model) | The cast in Settings |
| --- | --- |
| ![A stranger's profile with bio, follow counts and the posts they liked](screenshots/profile.png) | ![Settings: the timeline identity and the persona profile, with the button that asks the model to write it](screenshots/settings.png) |

| Trending, with made-up topics | Typing @ in the composer |
| --- | --- |
| ![The Trending tab: a bar of invented trending topics above the most engaged posts](screenshots/trending.png) | ![The mention picker listing known accounts under the composer](screenshots/mentions.png) |

<img src="screenshots/mobile.png" alt="Hopper on a phone" width="300">

Everything here is fiction; nothing is posted anywhere real. One caveat: **Refresh** sends the characters' profiles and the recent timeline to the configured model connection, local or remote. Keep anything that should not reach that API off the timeline.

The idea comes from the Noodle in [Marinara Engine](https://github.com/Pasta-Devs/Marinara-Engine). This is not a port, but the shape and the structural decisions are theirs.

## What it does

- Opens from the Character Menu, next to Roleplay and Conversation, or from the wand menu. It replaces the chat area while open; **Home** returns to the landing page.
- Keeps one or more timelines, each owned by a persona with its own name, type, profile, cast, follows and history.
- **Refresh** picks a few invited characters, writes profiles for any that lack one, and asks the model for posts, replies, reposts, likes, follows and poll votes in one request.
- Optional **strangers**: passers-by the model invents, who mostly reply and like. They are kept per timeline, so they have profiles, can be followed and turn up again later.
- Post by hand, with a picture from disk or a poll of two to four options.
- Like, repost and reply on every post; reply to a specific comment; delete your own posts and replies.
- `@` in a composer lists the accounts the timeline knows.
- Three tabs: **Main** is everything; **Following** is the accounts the persona follows; **Trending** is the most talked-about posts of the last two days, under a bar of made-up trending topics (tap one to search for it). A search box filters by text, author, handle, poll or reply text.
- Tap a like or repost count to see who did it.
- Profiles with Posts, Reposts, Likes and Media, and follow or unfollow from any profile.
- Optional **carryover** puts recent activity into a chat's prompt, so a character can mention the argument they had on the timeline. Off by default.
- Optional pictures through the existing image generation, an optional catch-up refresh on open, and an editable tone text.

## Using it

1. Choose **Hopper** in the Character Menu or the wand menu. The picker at the top switches timelines; **New timeline** starts another.
2. Open **Settings** inside Hopper and invite at least one character (or apply a host group), or let strangers join in.
3. Press **Refresh**. The status line says what it is doing.

**Posting.** Write in the box at the top. **Image** attaches a picture, **Poll** adds options, `@` picks an account to mention. Post text is shown as plain text with `@handles` linked; no HTML or markdown.

**Replying.** Every post and every reply has its own reply button. Replies show underneath with a "Replying to @someone" line rather than nesting. The number beside the heart or the repost arrows lists who liked or reposted.

**Profiles.** Click any name. Follow or unfollow from there.

## What Refresh does

It selects a few invited characters (plus a couple of known strangers, when strangers are on), writes missing profiles, and sends one request. With **One post at a time** on, it sends one request per post and shows each as it lands. The reply is JSON and is treated as untrusted. Before anything is stored:

- posts written as the persona are dropped
- invented accounts are dropped, except up to two new strangers per refresh; strangers write at most one post per refresh
- the quotas are re-applied
- duplicate likes, self-likes and repeated text from the same account are dropped
- votes must name a real option on a real poll

A note says how many items were dropped; details go to the console. A failed picture posts the text alone.

## Settings

All under **Settings** inside Hopper. The drawer in the Extensions panel only holds a button to open it.

- **Who posts** - which characters take part, whether strangers may join, and how many accounts are active per refresh.
- **Timeline identity** - name, freeform type (what sort of social setting this is), persona and equipped Scenario Notes.
- **Persona profile** - a timeline-only display name, handle, bio and location; it never rewrites the host persona. **Write it with the model** drafts all four from the persona description.
- **Connection** - which connection profile writes the posts. Unset, it uses the current connection. A cheap model is fine.
- **How much each refresh makes** - caps for posts, replies, reposts and likes (defaults 8, 12, 4 and 18).
- **One post at a time** - one request per post instead of one for the whole batch. More requests, but the first post shows up in seconds.
- **Pictures** - off by default; uses the existing image generation.
- **Voice** - the tone instructions, and the only editable part of the prompt. The rules that keep the response parseable stay out of it.
- **Feeding it back into chats** - carryover, off by default.
- **Catching up** - one refresh when the feed opens, if more than N hours have passed.

## Limits worth knowing

- **It cannot post while SillyBunny is closed.** It runs in the browser only; catch-up is the closest thing to a schedule.
- **The default tone says everyone is an adult** and lets characters be rude or explicit. It is a text box; rewrite it if that is not wanted.
- **Each timeline is its own file** in the user files directory, not in `settings.json`, which is copied into a backup rotation on every save. Settings only hold the session list and small configuration.
- **Existing installs keep their feed.** The original timeline becomes a session named **Timeline** and keeps using `twitterlike-feed.json`.
- **Reset** clears posts and reactions in the selected timeline and keeps its profile, follows and settings. An unreadable file offers Retry and Reset rather than starting over.
- Not in this version: GIFs and stickers, profile banners, quote-posts, nested thread trees, lorebook context, and showing generated pictures back to the model.

## Install

Use SillyBunny's extension installer with `https://github.com/platberlitz/SillyBunny-Hopper`, or clone it into `data/<user>/extensions/`. No server plugin, no build step, no dependencies.

## Development

```sh
npm test        # lint + unit tests, no dependencies
npm run lint    # syntax, formatting, manifest/package agreement
```

Needs Node 20.11 or newer. `src/core.js` is pure (prompt building, parsing, the rules above) and holds the tests; `src/api.js` is host I/O; `index.js` wires the lifecycle; `src/ui.js` is the only file that touches the DOM.

## License

AGPL-3.0, same as SillyBunny and Marinara Engine.
