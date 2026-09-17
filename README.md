# Harry Toolkit

English ｜ [繁體中文](README.zh-TW.md)

A personal toolkit for Obsidian that bundles a few small, self-contained tools for writers.
Every feature can be turned on or off individually in settings — a disabled feature adds no
commands, no views and no notices.

All data lives inside your vault, as note frontmatter, plain Markdown and JSON files.
Everything remains readable if you disable or remove the plugin.

**Network use:** only the *Threads analytics* feature connects to the internet. It calls
Meta's official Threads API to read your own account's data. It never posts. Every other
feature is fully offline.

| Feature | What it does |
| --- | --- |
| [Scrolling](#scrolling) | Scroll the document with a hotkey while the cursor stays put on screen |
| [Publishing calendar](#publishing-calendar) | A calendar for scheduling articles, tracking to-dos and getting due reminders |
| [Threads analytics](#threads-analytics) | Pull your own post metrics from the official API into a sortable dashboard |

---

## Scrolling

While drafting or proofreading a long document, the cursor stays at a fixed position on
screen and the text flows past it line by line — your eyes don't have to chase the cursor
and your hands never leave the keyboard. Similar to typewriter mode, but you control the pace.

Two commands, bindable under **Settings → Hotkeys** (search for "Harry Toolkit"):

| Command | Effect |
| --- | --- |
| Move content up (cursor stays in place) | Text flows upward; the cursor lands on the line that just arrived |
| Move content down (cursor stays in place) | Text flows downward |

- The cursor's on-screen position never moves; its document position follows, so you can
  start editing at the new spot immediately
- Hold the hotkey to scroll continuously, or tap it to move line by line
- Wrapped lines are measured correctly, and the target column is preserved so the cursor
  doesn't drift sideways when passing short lines
- At the top or bottom of the document the cursor simply settles on the first or last line
- Works in Source mode and Live Preview; Reading mode has no cursor, so it doesn't apply
- Works on both desktop and mobile

### Settings

- **Lines per scroll** — how many lines one keypress moves (default 1, max 20)
- **Smooth scrolling** — animate the scroll (off by default; keep it off if you hold the key down)

---

## Publishing calendar

Article scheduling plus a standalone to-do list, for writers. It does not connect to any
publishing platform — it keeps track of *your* plan. The main view is the calendar, opened
from the 📅 ribbon icon or the **Open publishing calendar** command.

### The calendar

- Each day shows scheduled articles (blue), published articles (green) and to-dos due that
  day (purple); overdue items get a red outline. Weeks start on Sunday
- Click empty space in a day cell to add a to-do due that day
- Drag to reschedule: scheduled articles and open to-dos can be dragged to another day.
  Hovering over the previous/next month arrow for about half a second flips the month, so
  you can drag across months
- Published articles and completed to-dos can't be dragged
- Hover a scheduled article for a ✓ to mark it published — **the publish date is the day
  cell it sits in**, so to backfill an old post, drag it to that day and click ✓
- Hover for an ✗ to unschedule (back to draft) or, on a published article, to revert it to
  scheduled
- To-dos have a checkbox to complete them, and a pencil button to rename them in place
  (Enter or click away to save, Esc to cancel)
- Below the grid are five collapsible sections — **Pinned notes**, **Drafts**,
  **Scheduled items**, **Unscheduled to-dos** and **File browser** — with buttons to
  expand or collapse all five at once
  - **Drafts** lists every note with `publish_status: draft`, most recently edited first.
    **Drag one onto a day to schedule it** — it moves out of drafts onto that day
  - **Scheduled items** is a flat, date-ordered overview of everything upcoming, across months
  - **Unscheduled to-dos** holds to-dos with no due date; drag one onto a day to give it one
- Put the calendar wherever you like — right sidebar, left sidebar or the main editor area.
  **It stays where you put it.** Re-running the command reveals the existing calendar rather
  than opening a second one, and Obsidian restores its position on restart
- Right-click the calendar's tab → **Move to new window** to pop it out onto a second monitor
- Click the day number to open that day's daily note, creating it if needed (it follows the
  core Daily notes plugin's format, folder and template settings). Days that already have a
  note get a small dot
- Drag and drop needs a mouse; on mobile, use the commands or edit the frontmatter directly

### File browser

A collapsible section at the bottom of the calendar that lets you browse folders without
leaving the calendar — a sidebar can only show one tab at a time, and switching to the file
explorer hides the calendar. **It starts collapsed**, so the calendar looks exactly as it
did before this feature existed.

- Browse from the vault root; click a folder to enter, the arrow to go up. Every level of
  the breadcrumb is clickable
- ★ is your favourite folders: pick one to jump there, or add the current folder from the
  bottom of the same menu
- The filter box filters the current level only, live as you type, and clears when you
  change folder
- The ↑↓ icon sets the sort order: **file name** (A→Z / Z→A), **modified time**
  (newest / oldest first) or **created date** (newest / oldest first). Your choice is
  remembered across restarts. Name sorting is numeric-aware, so `20260915` sorts by value.
  Folders have no timestamps, so they always sort by name (following the chosen direction)
  and stay above files
- Click a file to open it in the current tab; `Ctrl`/`Cmd`-click or middle-click opens it in
  a new tab. `.md` files hide their extension; images, PDFs and others show the full name
- **Drag any note onto a day cell to schedule it**, exactly like dragging from Drafts.
  Non-Markdown files can't be dragged (there's no frontmatter to write)
- Right-click a file or folder for **Open in new tab**, **Open to the right**, **Rename**,
  **Duplicate** and **Delete**, followed by items other plugins contribute. Renaming updates
  every link pointing at the file, and deleting follows your
  **Settings → Files and links → Deleted files** preference
- The list has a maximum height and scrolls internally, so a large folder never stretches
  the sidebar
- The current folder and sort order are remembered across restarts; if the folder is renamed
  or deleted, the browser quietly falls back to the vault root

### Article scheduling

- Any note can be scheduled. The schedule lives in the note's frontmatter:
  `publish_status` (idea / draft / scheduled / published), `publish_date` (planned),
  `published_date` (actual) and an optional `platform` tag
- **Schedule this note for publishing** opens a date picker; you can set the platform tag at
  the same time. The same action is on the right-click menu of any note (file explorer, tab
  title, editor menu and links)
- **Mark this note as published** sets the status and stamps today's date. To use a
  different date, click ✓ on the calendar instead
- Scanning can be limited to one folder in settings; leave it empty to scan the whole vault

### Pinned notes

- Right-click any Markdown note → **Pin note**; the same spot offers **Unpin** afterwards
- Pinning writes `pinned: true` to the note's frontmatter, and unpinning removes the field,
  leaving the note as it was. Adding the field by hand works too
- Pinning is not limited by the article scan folder

### To-dos

- To-dos are unrelated to articles and live in a Markdown file of your choice
  (`Todo.md` by default), in a format compatible with Obsidian's native checkboxes:
  `- [ ] Something 📅 2026-07-10`
- **Add to-do** works without opening the calendar
- **Add this note as a to-do** prefills a `[[link]]` to the current note
- Editing the file by hand works; the calendar keeps up automatically

### Due reminders

- Checks on startup and hourly, and notifies you about articles and to-dos due today or overdue
- Each item is announced once a day at most
- **Check due reminders now** runs the check on demand, and reminders can be turned off

### Settings

- **Article scan folder** — empty scans the whole vault
- **To-do file** — the Markdown file to store to-dos in (created if missing)
- **Calendar location** — where to open the calendar when it isn't open yet: right sidebar
  (default), left sidebar, main editor tab or a separate window. **An already-open calendar
  is never moved**
- **Due reminders** — on or off
- **Show file browser** — whether to include the file browser section
- **Favourite folders** — one folder path per line, listed in the file browser's ★ menu
- **File browser shows Markdown only** — hide images, PDFs and other non-note files

---

## Threads analytics

Reads your own Threads post metrics through Meta's official API and shows them as a sortable
dashboard inside Obsidian, plus one follower-count record per day.

**Read-only.** This feature has no ability to post, and never will.

### Getting an access token

1. Create an app of type **Threads API** in the [Meta developer console](https://developers.facebook.com/)
2. Find the **User Token Generator** under the app's Threads API settings
3. When generating the token, **tick `threads_basic` and `threads_manage_insights`** — without
   the second one you get posts but no metrics. Add `threads_read_replies` if you also want
   your replies
4. Paste the token under **Settings → Harry Toolkit → Threads analytics** and press
   **Test connection**

> ⚠️ **The token is stored in plain text**, in
> `<vault>/.obsidian/plugins/harry-toolkit/data.json` — Obsidian plugins have no access to
> the operating system's secure storage. If your vault is synced or pushed to Git, the token
> travels with it. The token is read-only, cannot post, and expires after 60 days, but
> please weigh that up for yourself.

Tokens last 60 days. The plugin refreshes yours automatically once it has fewer than 10 days
left (Meta requires a token to be at least 24 hours old before it can be extended). If one
does expire, generate a new one and paste it in.

### The dashboard

Open it from the bar-chart ribbon icon or the **Open Threads dashboard** command.

- **Account summary** — name, latest follower count, and the change since the previous record
- **Follower trend** — the last 90 days as a curve
- **Update recent posts** — fetch metrics for posts from the last N days (30 by default)
- **Refetch everything** — fetch metrics for every post
- **Sort and search** — by views, likes, replies, reposts, quotes, shares or publish date,
  with full-text search over post content
- **Include replies** — off by default. This checkbox only controls *display*; replies have
  to be fetched first (see below)
- Each row shows six numbers — views, likes, replies, reposts, quotes, shares — with the
  current sort column highlighted. Click a row to open the post in your browser

### How long a fetch takes

**Post metrics must be requested one post at a time** — the API has no batch endpoint — with
a 0.18 s pause between posts to stay within Meta's limits:

| Posts | Roughly |
| --- | --- |
| 200 | 1 minute |
| 500 | 2–3 minutes |
| 1000 | 5 minutes |

Progress is shown throughout and **Stop** is always available; whatever has been fetched is
still saved. Day to day, *Update recent posts* is enough. *Refetch everything* asks for
confirmation first, with a time estimate based on your post count.

**Closing the dashboard tab does not stop a fetch** — it runs on the plugin, not the view.
Reopening the dashboard reconnects to the same progress. Quitting Obsidian or disabling the
plugin does abort it, and since saving happens once at the end, that run is lost.

### Refetching never damages existing data

The data file is append-and-update only: posts that weren't queried this round keep their
existing numbers. So stopping halfway, individual failures, and repeated refetches are all
safe, and posts deleted on Threads stay in your records.

### Changing tokens or accounts

Regenerating a token for the same account is transparent — paste it in, test the connection,
and your existing data carries on.

The data file records which account it belongs to. If a new token belongs to a **different**
account, you get a warning before fetching, because mixing two accounts' posts into one file
makes the rankings meaningless. To track both, point the **data folder** setting somewhere
else, or move the existing `posts.json` aside.

To start over, delete `posts.json` and fetch again. **Don't delete `account-daily.json`** —
those follower counts can't be recovered.

### Fetching your replies

Replies come from a different endpoint (`me/replies`, not `me/threads`), so they're a
separate switch:

1. The token needs the **`threads_read_replies`** permission
2. Turn on **Also fetch my replies** in settings
3. Fetch again
4. Tick **Include replies** on the dashboard

Replies usually far outnumber posts, so fetching takes noticeably longer — hence the default.

**The reply-count column shows "—" for replies.** That's not a failure: Meta's API returns 0
for reply-type posts regardless of reality, so the number is meaningless. Views, likes,
reposts and quotes are all reported normally.

### Daily recording matters

Follower counts are only available as a *current* number — **the API offers no history, so a
day not recorded is lost forever**. The plugin therefore records one data point after load
(once per day, two API calls, under a second, and a failure never affects anything else). As
long as you open Obsidian regularly, the curve builds itself.

| Metric | Recoverable? |
| --- | --- |
| Follower count | ❌ No — only daily recording works |
| Account daily views | ✅ Backfillable to 2024-04-13 (**Backfill daily views** command) |
| Account daily likes, replies, reposts, quotes | Accumulates from first use |
| Per-post metrics | ✅ Always current on refetch |

Meta notes that figures from before 2024-06-01 are not guaranteed accurate.

### Data files

Two JSON files in the folder you choose (`Threads 數據` by default):

- `posts.json` — post content and latest metrics
- `account-daily.json` — one record per day of account-level numbers

**They live in your vault, not in the plugin folder**, so they survive uninstalling the
plugin and travel with your backups. Both are ordinary JSON you can read or feed to other tools.

### What this feature can't give you

- **Followers gained per post** — not exposed by the official API. The Threads website shows
  it, but scraping it would need an automated browser, which an Obsidian plugin can't do
- **Other people's accounts** — the API only covers your own
- **Audience demographics and link clicks** — available from the API, but deliberately not
  implemented: demographics need 100+ followers, and link clicks are aggregated per URL at
  the account level, so they can't be attributed to a post

### Settings

- **Access token** — see above
- **Test connection** — verifies the token and records the account id
- **Data folder** — where the JSON files go (empty means the vault root)
- **Days for "Update recent posts"** — default 30
- **Also fetch my replies** — off by default; needs `threads_read_replies`
- **Record account data daily** — on by default; leaving it on is strongly recommended
- **Dashboard location** — where to open the dashboard when it isn't open yet

---

## Enabling and disabling features

**Settings → Harry Toolkit** has one section per feature, each starting with an
**Enable this feature** toggle. A disabled feature's commands, views and notices all
disappear; the others are unaffected. **Toggling requires a reload to take effect** — disable
and re-enable the plugin under Community plugins, or press `Ctrl+R` / `Cmd+R`.

## Installation

### From Community plugins

**Settings → Community plugins → Browse**, search for **Harry Toolkit**, then Install and Enable.

### Manually

Download `main.js`, `manifest.json` and `styles.css` from the
[latest release](https://github.com/hharry112/harry-toolkit/releases) into
`<your vault>/.obsidian/plugins/harry-toolkit/`, reload Obsidian with `Ctrl+R` / `Cmd+R`, and
enable the plugin under Community plugins.

Afterwards, bind the two scrolling commands under **Settings → Hotkeys** (search for
"Harry Toolkit").

## Development

```bash
npm install
npm run dev     # watch and rebuild
npm run build   # production build, writes main.js
```

Type-check with `npx tsc --noEmit`.

### Project structure

```
src/
├─ main.ts          entry point: load settings, run the feature list, mount the settings tab
├─ core/            the Feature interface, settings merging, the shared settings tab
└─ features/
   ├─ index.ts      the feature registry — adding a feature means adding one line here
   ├─ scroll/
   ├─ scheduler/    calendar, articles, to-dos, reminders, file browser
   └─ threads/      API client, storage, sync, dashboard
```

Features never import the plugin class; they receive everything they need through a
`FeatureContext`, so each one can be added or removed without touching the others.

## License

[MIT](LICENSE)
