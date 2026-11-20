# hitl — Human In The Loop: the plan

One tool where an AI agent and its human meet: the agent **asks** (questions), **shows** (things to look at),
and **asks for review** (approve or change); the human **answers, reviews, marks up and explores** the project's files,
on any device, and sends **notes** back. Everything the human says lands in one feed the agent reads a little at a time.

It covers browsing a project (search, git, notes on files), question sets answered on a phone (MCP + CLI), showings
and reviews.

## Decisions (Phil, 2026-11-14)

- Name: `hitl` on npm. The repo and README say plainly: **Human In The Loop**.
- Full file browsing (search, git, notes) and full question sets, with text inputs that grow and wrap (no long
  single-line boxes).
- Explicit "review this": the agent shows things and asks for a verdict.
- Works well on phones, tablets and desktops. A more cohesive UX than the two tools side by side.
- File viewing performance is handled (big files, big folders).
- Requests are each their own file (one per question set, showing or review), so one agent's request never clears
  another's.
- In: (1) one inbox, (2) one feedback stream, (3) notes from the human to the agent (with photos), (4) approval gates,
  (5) snapshots, (6) swipe review, (7) before/after, (8) performance, (9) a decision log, (11) who's asking,
  push notifications to the phone.
- (12) Claude Code hooks are an option the user turns on (`hitl init --hook`, `--stop-hook`), not the default.

## Decisions: the machine dashboard (Phil, 2026-11-19)

Phil's request: "Update hitloop project to have a master dashboard for the machine. Showing anything node can get its
hands on, stored in local round robin databases. Like system memory, CPU, etc. also a view of all the Claude agents
running on the machine or something if they exist. Some cool stats from those transcript files around tokens etc. a
master dashboard with tons of cool graphs on everything available to us. Also different tool call occurrences and
durations or something. Whatever we can get for free that's the ultimate view into what's going on. Because Claude
hides workflows and subagent info sometimes it's painful. All of this should be something that is optin and they can
turn it off temporarily if they want."

His answers (question set `machine-dashboard`):

- Where: a Machine page in the hitl hub.
- On and off: off until you turn it on in Settings; a Pause button for 1 h / until restart / until I resume.
- System graphs: top processes, and total CPU/RAM of all claude and node processes; GPU %, VRAM, temperature
  (nvidia-smi); network up/down per adapter; disk free per drive + read/write speed; memory used / free; CPU total and
  per core.
- Claude views: live sessions (name, folder, busy/idle, how long, CPU/RAM of its process); tokens over time (input,
  output, thinking, cache read/write, by model and by project); tool calls (count, median and slowest durations,
  errors, per tool); agent tree (a session's subagents and workflows, nested, with tokens, tool calls, time and status);
  workflow runs (phases, agent count, duration, tokens, script, final result); estimated cost (API list prices ×
  tokens), clearly marked as an estimate; cache hit rate and context size per turn; activity heatmap (hours × days).
- History: the last 30 days, then keep going.
- Storage: round-robin ring files for time series + a small JSON index per session for the agent tree.
- Sampling: every 5 seconds, every 1 s while the page is open.
- Hooks for live tool timing: no, transcripts are enough. OpenTelemetry: not now; maybe later.
- Phone too: cards stack, graphs scroll sideways.

Built in `src/machine/` (rrd.ts, system.ts, claude.ts, prices.ts, index.ts) and `client/src/machine/`.

Added 2026-11-19 (Phil): workflows fold and stay folded (localStorage `hitl:machine-fold`; finished ones fold by default), the
newest first; click any agent or the main conversation to read it (messages, thinking, tool calls with results and
durations, every picture it read) at `#/machine/s/<session>/c` and `/a/<agent>`, backed by `api/machine/transcript` and
`api/machine/transcript-image`.

## Decisions: notifications and https (Phil, 2026-11-20)

Phil's requests:

- "For the hitloop project how can we get it to work with https so we can get push notifications?" then "Assume no
  tailscale, just localhost or localip", and on the options: "Let's do option A so localip and localhost can server
  https so whether I'm using it on my machine only or for a phone I can get push notifications. Let's add push
  notifications for all the things AI can do with options to toggle it. Also for machine mode, maybe when certain
  thresholds are met absolutely or within a timeframe for any of the metrics we track we could get notifications."
- "Lets remove all traces of ntfy - I don't want that anymore"
- "Also remove references to questionme and folderview from the project" (the import command and .folderviewignore went too)
- "lets also add slack integration support - so user could supply slackwebhook for notifications"

Built:

- **https** (`src/hub/tls.ts`): hitl's own certificate authority (P-256, ten years, name-constrained to private
  addresses, localhost and this computer's name) issues the hub a certificate for every local address, made again when
  an address changes. One port answers both http and https (the first byte of a connection says which); `https` in
  config.json (`hitl https on|off`, or the page) turns it on with no restart. The CA is downloadable at `hitl-ca.crt`;
  the page walks Android, iPhone and other computers through installing it and checks whether a device trusts it.
- **Web Push** (`src/hub/webpush.ts`): VAPID (RFC 8292) and aes128gcm (RFC 8291) by hand, no dependencies; keys and
  devices in `~/.config/hitl/push.json`; `client/sw.js` shows them and opens the page at the right place.
- **Events** (`EVENTS` in `src/hub/notify.ts`), each on or off: questions, approvals, reviews, showings, replies (on);
  acks, resolved notes, edits (off); a Claude Code session finished, a workflow finished (off; need the dashboard);
  machine alerts (on). ntfy removed; a webhook stays.
- **Slack**: an incoming webhook (`notify.slack`, only hooks.slack.com accepted), set on the page or with
  `hitl notify slack <url>`; each notification is a Block Kit message (bold title, details, an "Open in hitl" button).
- **Machine alerts** (`src/machine/alerts.ts`): rules on any level (held N minutes, 0 = at once) or any total over a
  window, with a cooldown; in config.json `machine.alerts`, edited on the Notifications page (`#/notify`).

## Shape

```
<project>/.hitl/
  questions/<set>.json     question sets                                agent writes
  shows/<id>.json          showings and review requests                 agent writes
  approvals/<id>.json      approval gates (one question, yes/no)        agent writes
  answers/<id>.json        everything the human said about one request  hitl writes
  answers/<id>.md          the same, readable                           hitl writes
  notes.json               notes from the human: on files, lines,       hitl writes
                           picture areas, or free-standing, with photos
  media/                   pictures the agent passed as data, photos the human attached, marked-up copies
  NEWS.md                  what's new for the agent, readable
```

- **One hub** (`npx hitloop`) serves every project on one port (4199), with a token, on the LAN and Tailscale.
- **The page**: an Inbox across projects ("waiting on you"); each project has Files, Questions,
  Reviews (showings), Notes, Changes, Decisions. One look (one set of design tokens), one top bar, one settings
  panel.
- **The agent**: one MCP server (`hitl mcp`) and a CLI with the same verbs: `ask`, `show`, `review`, `approve`,
  `news`, `wait`, `reply`, `ack`/`resolve`, `decisions`, `link`. `hitl news` is one stream across every request.
- **Who's asking**: every request records `from` (the agent's session name, the git branch, or what it passes).
- **Notifications**: Web Push straight from the hub (https built in for phones) or a webhook, batched, for new questions, reviews, approvals and replies (see Decisions: notifications).

## Phases

1. Skeleton: repo, package, build, the hub serving each project's files under `p/<key>/`.
2. Questions: the store, API, pages and MCP tools.
3. Shows and reviews: the format, the page (items, verdicts, line comments, picture marks, swipe), the tools.
4. Notes, approvals, the news stream, wait, decisions, who's asking.
5. One page: the inbox, project home, shared top bar and settings; inputs that grow; phone, tablet and desktop passes.
6. Performance: windowed code view, highlighting off the main thread, cached listings.
7. Hooks (optional), notifications, README, screenshots, tests, release workflow.
