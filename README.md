# SillyBunny TwitterLike

A pretend social timeline for your own cast. Your persona and the characters you invite each get an account, and pressing **Refresh** hands them to a model that writes a batch of posts, replies, reposts, likes and follows in one go. You can post by hand too, and like or reply to anything.

It's fake. Nothing leaves your machine, nothing is posted anywhere real, and no account here belongs to a person who exists.

I built this after seeing the Noodle in Marinara Engine and wanting the same thing in SillyBunny. This isn't a port - none of Marinara's plumbing would survive the trip - but the idea is theirs and the good structural decisions are theirs too. Credit where it's due.

The bit that makes it more than a toy is **carryover**: recent activity can be dropped into a chat's prompt, so a character can reference the argument they had on the timeline this morning. That's off by default.

## Install

1. Open **Customize** and go to **Extensions**.
2. Choose **Install extension** and paste this URL:

```
https://github.com/platberlitz/SillyBunny-TwitterLike
```

3. There's a `#` button in the top bar afterwards. It's also in the wand menu if you prefer.

No server plugin, no build step, no dependencies.

## Using it

Open it and you get a full-screen timeline under the top bar. **Main** is everything, **Following** is only the accounts your persona follows.

Write a post in the box at the top. You can attach one picture from your computer and add a poll of two to four options. Posting by hand doesn't need an AI connection at all.

Every post has three buttons - like, repost, reply. Replies show underneath with a 'Replying to @someone' line rather than nesting forever, which is deliberate: nested threads look clever and read badly.

Click any name to open that account's profile, where you can follow or unfollow.

Before **Refresh** does anything you need to go to **Settings** inside the feed and invite at least one character, or turn on the ambient accounts. Then press Refresh and wait.

## What Refresh actually does

It picks a few of your invited characters - the ones who have been quiet longest, so the same two don't monopolise the timeline - writes profiles for any of them that don't have one yet, and then makes a single request asking for a batch of activity.

The reply comes back as JSON and I don't trust a word of it. Before anything is stored:

- Anything written as your persona is thrown away. The model does not get to speak as you.
- Invented accounts are thrown away.
- The quotas are re-applied, whatever the model decided to do.
- An account can't like the same post twice, or like its own post.
- Repeated text from the same account is dropped.
- Votes have to name a real option on a real poll.

If it drops things you'll get a note saying how many, and the details go to the console.

If images are on, each generated image prompt goes through your existing image setup. A failed image just posts the text, which is what you'd want.

## Settings

All of them live inside the feed window, under **Settings** in the left nav. There's a drawer in the Extensions panel too, but it only has a button to open the feed - a timeline doesn't belong in a half-width settings column.

- **Who posts** - which characters take part, whether the ambient strangers join in, and how many accounts are active per refresh.
- **Connection** - which connection profile writes the posts. A cheap model is genuinely fine here, and I'd recommend picking a separate one rather than burning your roleplay connection on shitposts. If you leave it unset it uses whatever you're currently connected to.
- **How much each refresh makes** - caps for posts, replies, reposts and likes. Defaults are 8, 12, 4 and 18.
- **Pictures** - off by default. Uses your existing image generation.
- **Voice** - the tone instructions. This is the only part of the prompt you can edit, on purpose: the rules that keep the response parseable aren't in there, so you can rewrite the voice however you like and you can't break a refresh doing it.
- **Feeding it back into chats** - carryover. Off by default.
- **Catching up** - optionally run one refresh when you open the feed, if it's been more than N hours.

## Things to know

**It can't post while SillyBunny is closed.** This is an extension, so it's just JavaScript in your browser tab - there's no server side to it. Marinara can run its timeline on a schedule because it has a server process; I don't. The catch-up setting is the closest thing: one refresh when you open the feed if enough time has passed.

**The default tone says everyone on the timeline is an adult** and lets characters be rude, petty and explicit where it suits them. It's a text box - rewrite it if that's not what you want.

**The feed is stored as a file**, not in your settings. That's not an implementation detail I'm proud of, it's the whole reason this is safe to use: everything in `settings.json` gets re-serialised and copied into a fifty-deep backup rotation on every save, so a growing feed in there would quietly wreck your write performance. Posts live in your user files directory instead. Settings only holds the config, the profiles and the follows.

**Post text is never rendered as HTML.** It's inserted as text, with `@handles` turned into links. No markdown, which is also how the real thing works.

**Resetting the timeline** clears posts, replies, likes and reposts, and keeps profiles, follows and settings.

## Not in this version

GIFs and stickers, profile banners, quote-posts, threads deeper than one reply, lorebook keyword context, showing generated pictures back to the model, and multiple persona accounts you can switch between. Say if you want any of them and I'll have a look.

There's also no NoodleR equivalent and there isn't going to be one.

## Development

```
npm test        # lint + unit tests, no dependencies
npm run lint    # syntax, formatting, manifest/package agreement
```

Needs Node 20 or newer. `src/core.js` is pure - prompt building, parsing and every rule above - and is where the tests actually live. `src/api.js` is the only file that talks to the host, `src/ui.js` is the only one that touches the DOM.

## License

AGPL-3.0. Same as SillyBunny, and same as Marinara Engine, which this borrows its shape from.
