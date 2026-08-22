# SillyBunny Twitlike

A pretend social timeline for a SillyBunny cast: persona-scoped sessions with their own profiles, Scenario Notes, invited characters, follows and history, filled by one model request per **Refresh**, with posting, replies, reposts, likes, polls and pictures by hand.

![Twitlike: the Main timeline with posts and threaded replies](screenshots/timeline.png)

| A character's profile | The cast in Settings |
| --- | --- |
| ![A character profile with bio, location, follow counts and their posts](screenshots/profile.png) | ![The Who posts section: invited characters, ambient strangers and accounts per refresh](screenshots/settings.png) |

| Typing @ in the composer | On a phone |
| --- | --- |
| ![The mention picker listing known accounts under the composer](screenshots/mentions.png) | <img src="screenshots/mobile.png" alt="Twitlike on a phone" width="300"> |

Everything here is fiction. Nothing is posted anywhere real, and no account belongs to a person who exists. One caveat worth stating plainly: **Refresh** sends the characters' profiles and the recent timeline to whichever model connection is configured, local or remote. Anything that should not reach that API should not be on the timeline.

The idea comes from the Noodle in [Marinara Engine](https://github.com/Pasta-Devs/Marinara-Engine); this is not a port, none of Marinara's plumbing would survive the trip, but the shape and the good structural decisions are theirs. Credit where it is due.

## What it does

- Runs as a chat workspace: **Twitlike** sits in the Character Menu next to Roleplay and Conversation (and in the wand menu), replaces the chat area while open, and leaves the top bar usable; **Home** returns to the landing page.
- Keeps one or more timeline sessions, each owned by a persona with its own name, type, profile, cast, follows and history. Switching sessions equips that session's persona.
- **Refresh** picks a few invited characters (the ones quiet longest), writes profiles for any that lack one, and asks the model for a batch of posts, replies, reposts, likes, follows and poll votes in a single request.
- Posting by hand, with one picture from disk and a poll of two to four options; **Refresh** lives in the same button row.
- Like, repost and reply on every post; reply to a specific comment; delete your own replies and posts.
- `@` in a composer lists the accounts the session knows (persona, invited characters, ambient strangers); arrows move, Enter or Tab inserts the handle.
- **Main** is everything; **Following** is the accounts the persona follows, their posts and reposts with an attribution line. A search box filters the current timeline by text, author, handle, poll text or reply text.
- Profiles with Posts, Reposts, Likes and Media sections, and follow/unfollow from any profile.
- Optional **carryover**: recent activity dropped into a chat's prompt, so a character can refer to the argument they had on the timeline this morning. Off by default.
- Optional pictures through the existing image generation, an optional catch-up refresh on open, and a tone text that is the only editable part of the prompt.

## Using it

**Opening it.** Choose **Twitlike** in the Character Menu, beside Roleplay and Conversation, or use the wand menu. The session picker at the top switches timelines; **New timeline** starts another one.

**Before the first Refresh.** Open **Settings** inside the feed and invite at least one character, apply a host group as the cast, or turn on the ambient strangers. Then press **Refresh** and wait; the status line says what it is doing.

**Posting.** Write in the box at the top. **Image** attaches one picture, **Poll** adds two to four options. Type `@` to pick an account to mention; the handle is inserted as `@handle`. Post text is never rendered as HTML: it is inserted as text with `@handles` turned into links, and no markdown, which is also how the real thing works.

**Replying.** Every post has like, repost and reply; every reply has its own reply button, so one comment can be answered rather than the whole post. Replies show underneath with a 'Replying to @someone' line instead of nesting forever, which is deliberate: nested threads look clever and read badly.

**Profiles.** Click any name. Follow or unfollow from there.

## What Refresh actually does

It selects a few invited characters, writes profiles for those that have none, and sends one request. The reply comes back as JSON and is treated as untrusted. Before anything is stored:

- anything written as the persona is dropped; the model does not speak as the user
- invented accounts are dropped
- the quotas are re-applied, whatever the model decided
- an account cannot like the same post twice, or like its own post
- repeated text from the same account is dropped
- votes must name a real option on a real poll

When things are dropped, a note says how many and the details go to the console. With pictures on, each generated image prompt goes through the existing image setup; a failed image just posts the text.

## Settings

All of them live inside the Twitlike workspace under **Settings**. The drawer in the Extensions panel only holds a button to open Twitlike; a timeline does not belong in a half-width settings column.

- **Who posts** - which characters take part, whether the ambient strangers join in, and how many accounts are active per refresh.
- **Timeline identity** - the session's name, freeform type, persona and equipped Scenario Notes. The type tells the model what sort of social setting this is; it is not a fixed list.
- **Persona profile** - a timeline-only display name, handle, bio and location. It never rewrites the host persona.
- **Connection** - which connection profile writes the posts. A cheap model is fine here; a separate one saves the roleplay connection for roleplay. Unset, it uses the current connection.
- **How much each refresh makes** - caps for posts, replies, reposts and likes. Defaults are 8, 12, 4 and 18.
- **Pictures** - off by default; uses the existing image generation.
- **Voice** - the tone instructions, and the only part of the prompt that can be edited. The rules that keep the response parseable are not in there, so the voice can be rewritten freely without breaking a refresh.
- **Feeding it back into chats** - carryover, off by default.
- **Catching up** - optionally one refresh when the feed opens, if more than N hours have passed.

## Limits worth knowing

- **It cannot post while SillyBunny is closed.** This is browser-side JavaScript with no server process; the catch-up setting is the closest thing to a schedule.
- **The default tone says everyone on the timeline is an adult** and lets characters be rude, petty and explicit where it suits them. It is a text box; rewrite it if that is not wanted.
- **Each timeline is stored as its own file**, in the user files directory, not in `settings.json`. Everything in `settings.json` is re-serialised and copied into a fifty-deep backup rotation on every save, so a growing feed there would quietly wreck write performance. Settings only hold the session catalogue and small configuration records.
- **Existing installs migrate without rewriting the feed.** The original timeline becomes a session named **Timeline** and keeps using `twitterlike-feed.json`; new sessions get separate files.
- **Resetting the timeline** clears posts, replies, likes, reposts and votes in the selected session and keeps its profile, follows and settings. If a saved file cannot be read, the feed offers Retry and Reset rather than silently starting over.
- Not in this version: GIFs and stickers, profile banners, quote-posts, visually nested thread trees, lorebook keyword context, and showing generated pictures back to the model.

## Install

Use SillyBunny's extension installer with `https://github.com/platberlitz/SillyBunny-Hopper`, or clone it into `data/<user>/extensions/`. No server plugin, no build step, no dependencies.

## Development

```sh
npm test        # lint + unit tests, no dependencies
npm run lint    # syntax, formatting, manifest/package agreement
```

Needs Node 20.11 or newer (for `import.meta.dirname` in the lint script). `src/core.js` is pure (prompt building, parsing, every rule above, the mention matcher) and is where the tests live. `src/api.js` holds nearly all host I/O, `index.js` wires the lifecycle events, and `src/ui.js` is the only file that touches the DOM.

## License

AGPL-3.0, same as SillyBunny and as Marinara Engine, which this borrows its shape from.
