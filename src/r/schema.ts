// The review format as JSON Schema: published as schema/reviews.schema.json, printed by `hitl schema reviews`, and
// given to agents in the MCP tools' input schemas.

export const itemSchema = {
  type: 'object',
  description:
    'One thing to look at. Give exactly one content field: file (a project path; with lines "10-40" for part of it, or against "HEAD"/"main" for its changes since then), files (several paths at once), code (+ lang, name), text, md, json, diff (unified), image (project path, https URL or data:image URL), mermaid, html (sandboxed mockup, no scripts; height), link (+ label). Add title, note (markdown: what to look at), ask (the question for this item), before (an earlier picture or text, for a before/after view), collapsed.',
  properties: {
    id: { type: 'string', description: 'Stable id (made from the title or file if left out)' },
    title: { type: 'string' },
    note: { type: 'string', description: 'Markdown: what to look at, what changed, what you want to know' },
    ask: { type: 'string', description: 'What you are asking about this item ("Is the spacing right?")' },
    file: { type: 'string', description: 'A path relative to the project folder' },
    files: { type: 'array', items: { type: 'string' }, description: 'Several project paths: one item each' },
    lines: { oneOf: [{ type: 'string', pattern: '^\\d+(-\\d+)?$' }, { type: 'integer' }] },
    against: { type: 'string', description: 'With file: show its changes since this git revision (HEAD, main, a hash)' },
    snapshot: { type: 'boolean', description: 'With file: keep a copy as it is now (default true) so later edits show as changed' },
    code: { type: 'string' },
    lang: { type: 'string' },
    name: { type: 'string', description: 'A file name to show (and to guess the language from)' },
    text: { type: 'string' },
    md: { type: 'string' },
    json: { description: 'Any JSON value, shown as a tree' },
    diff: { type: 'string', description: 'A unified diff' },
    image: { type: 'string', description: 'A project path, an https: URL, or a data:image/…;base64 URL' },
    alt: { type: 'string' },
    before: { type: 'string', description: 'Before/after: the earlier picture (path, URL or data URL) for image, or the earlier text for code/text' },
    mermaid: { type: 'string' },
    html: { type: 'string' },
    height: { type: 'number' },
    link: { type: 'string' },
    label: { type: 'string' },
    collapsed: { type: 'boolean' },
  },
  additionalProperties: false,
};

export const reviewSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://unpkg.com/hitl/schema/reviews.schema.json',
  title: 'hitl review',
  description: 'Things an agent shows the human to look at, review or approve (.hitl/reviews/<id>.json).',
  type: 'object',
  properties: {
    $schema: { type: 'string' },
    title: { type: 'string' },
    intro: { type: 'string', description: 'Markdown at the top: what this is and what you want' },
    mode: { enum: ['review', 'show', 'approve'], description: 'review: a verdict per item; show: just look; approve: one yes or no' },
    status: { enum: ['open', 'closed'] },
    from: { type: 'string', description: "Who's asking: an agent session's name, a branch" },
    created: { type: 'string' },
    updated: { type: 'string' },
    items: { type: 'array', items: itemSchema },
  },
  additionalProperties: false,
};
