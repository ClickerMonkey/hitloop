# hitl — Human In The Loop: the plan

One tool where an AI agent and its human meet: the agent **asks** (questions), **shows** (things to look at),
and **asks for review** (approve or change); the human **answers, reviews, marks up and explores** the project's files,
on any device, and sends **notes** back. Everything the human says lands in one feed the agent reads a little at a time.

It merges [folderview](https://github.com/ClickerMonkey/folderview) (browse, search, git, review comments) and
[questionme](https://github.com/ClickerMonkey/questionme) (question sets, answered on a phone, MCP + CLI), copying as
much of their code as possible, and adds showings and reviews.

## Decisions (Phil, 2026-11-14)

- Name: `hitl` on npm. The repo and README say plainly: **Human In The Loop**.
- All folderview features. All questionme features, with text inputs that grow and wrap (no long single-line boxes).
- Explicit "review this": the agent shows things and asks for a verdict.
- Works well on phones, tablets and desktops. A more cohesive UX than the two tools side by side.
- File viewing performance is handled (big files, big folders).
- Requests are each their own file (one per question set, showing or review), so one agent's request never clears
  another's.
- In: (1) one inbox, (2) one feedback stream, (3) notes from the human to the agent (with photos), (4) approval gates,
  (5) snapshots, (6) swipe review, (7) before/after, (8) performance, (9) a decision log, (11) who's asking,
  push notifications to the phone.
- (12) Claude Code hooks are an option the user turns on (`hitl init --hook`, `--stop-hook`), not the default.
- questionme and folderview stay published; their READMEs point to hitl. `hitl import` brings in `.questionme/` and
  `.review/` folders.

## Shape

```
<project>/.hitl/
  questions/<set>.json     question sets (questionme's format)          agent writes
  shows/<id>.json          showings and review requests                 agent writes
  approvals/<id>.json      approval gates (one question, yes/no)        agent writes
  answers/<id>.json        everything the human said about one request  hitl writes
  answers/<id>.md          the same, readable                           hitl writes
  notes.json               notes from the human: on files, lines,       hitl writes
                           picture areas, or free-standing, with photos
  media/                   pictures the agent passed as data, photos the human attached, marked-up copies
  NEWS.md                  what's new for the agent, readable
```

- **One hub** (`npx hitl`) serves every project on one port (4199), with a token, on the LAN and Tailscale.
- **The page**: an Inbox across projects ("waiting on you"); each project has Files (folderview), Questions,
  Reviews (showings), Notes, Changes, Decisions. One look (folderview's design tokens), one top bar, one settings
  panel.
- **The agent**: one MCP server (`hitl mcp`) and a CLI with the same verbs: `ask`, `show`, `review`, `approve`,
  `news`, `wait`, `reply`, `ack`/`resolve`, `decisions`, `link`. `hitl news` is one stream across every request.
- **Who's asking**: every request records `from` (the agent's session name, the git branch, or what it passes).
- **Notifications**: ntfy or a webhook, batched (from questionme), for new questions, reviews, approvals and replies.

## Phases

1. Skeleton: repo, package, build, the hub serving folderview per project under `p/<key>/`.
2. Questions: questionme's store, API, pages and MCP tools, moved over.
3. Shows and reviews: the format, the page (items, verdicts, line comments, picture marks, swipe), the tools.
4. Notes, approvals, the news stream, wait, decisions, who's asking.
5. One page: the inbox, project home, shared top bar and settings; inputs that grow; phone, tablet and desktop passes.
6. Performance: windowed code view, highlighting off the main thread, cached listings.
7. Import, hooks (optional), notifications, README, screenshots, tests, release workflow.
