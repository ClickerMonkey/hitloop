---
name: hitl
description: Human In The Loop. Use hitl to put things in front of the user on their phone or computer instead of asking in chat - more than about 4 questions, anything to look at or review (files, diffs, screenshots, mockups), or a yes/no before something risky (deploy, delete, spend, send) - and to read what they said back (answers, verdicts, comments on lines and pictures, notes on files). Also when the user mentions hitl, approvals, reviewing on their phone, or "ask me there".
---

# hitl: Human In The Loop

hitl (`npx hitl`, npm package `hitl`) gives the user one inbox, on their phone or computer, for everything an agent
needs from them. What they say is saved in the project under `.hitl/` and read back a little at a time. Prefer the
hitl MCP tools when they are loaded (`news`, `show`, `approve`, `add_questions`, `wait`, …); otherwise use the CLI,
which does the same. `npx hitl --help` lists every command and option: check it instead of guessing flags.

## When to use it

- **More than about 4 questions**, or questions that need thought or pictures → a question set.
- **Something to look at or review** (files, a diff, screenshots, a mockup, a plan) → a review.
- **A yes or no before something risky or hard to undo** (deploy, delete data, spend money, send a message) → an
  approval. Never do the risky thing until it says APPROVED.
- **Before asking something that may have been decided already** → check the decisions.

## Setup (once per project)

```sh
npx hitl init            # .hitl/, the MCP server for Claude Code, a note in CLAUDE.md
npx hitl                 # start the page (the hub); prints links for the user's phone
```

## Asking questions

MCP `add_questions` (set, title, questions), or write `.hitl/questions/<set>.json` (`npx hitl schema questions`), or:

```sh
npx hitl ask <set> --file questions.json --title "Login: first plan"
```

Each question: a stable `id`, a short `question`, `options` (each with a `description`), one marked
`recommended: true`, and `why` it matters. Mark what you can't go on without `"blocking": true`. Follow-up questions
start `"hidden": true` and an option `"shows": ["their-id"]`. Show files, code, diffs, diagrams and HTML mockups as
`content` blocks rather than long prose.

## Showing things for review

```sh
npx hitl show src/login.tsx screens/login.png --mode review --title "Login, round 2" --intro "What I changed and why"
git diff | npx hitl show - --mode review --title "The change"
```

MCP `show` takes `items`, each one of: `file` (with `lines: "10-40"`, or `against: "main"` for its changes since),
`code` (+ `lang`, `name`), `text`, `md`, `json`, `diff`, `image` (path, https URL or data URL), `mermaid`, `html`
(sandboxed mockup), `link`. Add `title`, `note` (what to look at), `ask` (the question for this item) and `before` (an
earlier picture or text, for a before/after view). `mode: "review"` asks a verdict per item; `"show"` is just to
look. Every call makes its own review; it never replaces another's. Add to one with `to: "<review id>"`.

## Asking for approval

```sh
npx hitl approve "Deploy 2.4.0 to production?" --details "Restarts the API (~20 s of 503s). Undo: deploy rollback 2.3.9" --timeout 30m
# exit 0: approved, 1: refused or changes asked for, 2: no answer yet
```

MCP `approve` (question, details, items) waits up to 15 minutes and returns APPROVED, REFUSED or NOT YET with the
user's note.

## Giving the link, then waiting

Send the user the link the tool or command prints (`npx hitl url [id]` prints it again). Keep working on whatever
doesn't depend on the answer. To wait, run in the background (it exits, waking you, when the user has said something):

```sh
npx hitl wait --any                 # anything new
npx hitl wait --done <review|set>   # they've finished a review, answered an approval, or answered a whole set
npx hitl wait --blocking <set>      # the blocking questions are answered
```

## Reading what they said

```sh
npx hitl news           # everything new since you last read, across every request and note (marks it read)
npx hitl feedback <review> --all
npx hitl answers <set> --open
npx hitl notes --open   # notes the user wrote on files, lines, picture areas, or about anything
npx hitl decisions auth # what they decided before about "auth"
```

MCP: `news`, `get_feedback`, `get_answers`, `notes`, `decisions`.

Then close the loop, so the user sees it was handled:

```sh
npx hitl ack <set|review> <id…> --note "Done in src/login.tsx"         # answers and verdicts
npx hitl resolve [<review>] <comment-or-note id…> --note "Fixed: …"     # comments (c12) and notes
npx hitl reply <review> c12 "Because the API bills per call."
```

Put the user's words into docs and plans word for word. Say who's asking with `from` (MCP) or `--from` (CLI): your
session's name or the branch.

## Where things live

`.hitl/questions/`, `.hitl/reviews/` (the agent writes these), `.hitl/answers/` and `.hitl/notes/` (hitl writes these,
with readable `.md` copies), `.hitl/media/` (pictures, snapshots, photos). Formats: `npx hitl schema questions|reviews`.
