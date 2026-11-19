// A made-up Claude Code home for the README's machine pictures: one session with a main conversation (a picture
// it read included), four workflow runs and their agents. Nothing in it is real, so nothing in a picture can leak.
//   node scripts/demo-claude.mjs <folder>        then run a hub with CLAUDE_CONFIG_DIR=<folder> and HITL_HOME=<another>
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? '.demo/claude');
fs.rmSync(root, { recursive: true, force: true });
const SESSION = '5d1c0a52-7be4-4d52-9a0b-3a6f8f0c2b11';
const CWD = '/home/dev/orchard';
const proj = path.join(root, 'projects', '-home-dev-orchard');
const sdir = path.join(proj, SESSION);
const now = Date.now();
const MODEL = 'claude-sonnet-5-5';
let n = 0;
const id = (p) => `${p}_${String(++n).padStart(6, '0')}`;
const put = (file, lines) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
};
const base = (type, t, extra = {}) => ({ parentUuid: null, isSidechain: false, type, timestamp: new Date(t).toISOString(), sessionId: SESSION, cwd: CWD, gitBranch: 'main', version: '2.1.150', uuid: id('u'), ...extra });
const usage = (o = 1200, cr = 40000, cw = 1800) => ({ input_tokens: 40, output_tokens: o, cache_read_input_tokens: cr, cache_creation: { ephemeral_5m_input_tokens: cw, ephemeral_1h_input_tokens: 0 } });
const say = (t, content, u = usage()) => base('assistant', t, { message: { id: id('msg'), role: 'assistant', model: MODEL, content, usage: u } });
const user = (t, content) => base('user', t, { message: { role: 'user', content } });
const use = (name, input) => ({ type: 'tool_use', id: id('toolu'), name, input });
const result = (call, content, error = false) => ({ type: 'tool_result', tool_use_id: call.id, content, ...(error ? { is_error: true } : {}) });

// a picture the agent "read": one of the repo's own demo screenshots
const shot = fs.readFileSync(path.resolve('docs/screens/phone-inbox.jpg')).toString('base64');

// ── the main conversation ──
const T0 = now - 3 * 86400_000;
const main = path.join(proj, SESSION + '.jsonl');
const grep = use('Grep', { pattern: 'pearScore', path: 'src' });
const read = use('Read', { file_path: '/home/dev/orchard/src/pears/score.ts' });
const look = use('Read', { file_path: '/home/dev/orchard/docs/mockups/inbox.jpg' });
const test = use('Bash', { command: 'npm test -- --run pears', description: 'Run the pear tests' });
const fail = use('Bash', { command: 'npm run build', description: 'Build the orchard' });
put(main, [
  { type: 'custom-title', customTitle: 'Add a pear-picking game to the orchard' },
  user(T0, 'Add a pear-picking game to the orchard: tap the ripe pears before they fall. Look at the inbox mockup for the look, and keep the score logic in its own file with tests.'),
  say(T0 + 8_000, [{ type: 'thinking', thinking: 'The score logic should be a pure function so it is easy to test. Let me look at what exists and at the mockup before writing anything.', signature: 'x' }, { type: 'text', text: "I'll start by finding where scoring lives today, then look at the mockup you mentioned." }, grep]),
  user(T0 + 11_000, [result(grep, 'src/pears/score.ts:3:export function pearScore(ripeness: number, ms: number): number {\nsrc/pears/score.test.ts:5:  expect(pearScore(1, 0)).toBe(100)')]),
  say(T0 + 14_000, [read]),
  user(T0 + 15_000, [result(read, 'export function pearScore(ripeness: number, ms: number): number {\n  // riper pears score more; slower taps score less\n  return Math.max(0, Math.round(100 * ripeness - ms / 50))\n}\n')]),
  say(T0 + 20_000, [{ type: 'text', text: 'Now the mockup, so the game matches the rest of the app.' }, look]),
  user(T0 + 23_000, [{ type: 'tool_result', tool_use_id: look.id, content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: shot } }] }]),
  say(T0 + 40_000, [{ type: 'text', text: "The mockup uses **cards on a soft background** with one accent colour. Plan:\n\n1. `src/pears/game.ts`: the falling-pear loop (pure, seeded)\n2. `src/pears/score.ts`: already exists, I'll extend it with a combo bonus\n3. tests for both\n\nRunning the existing tests first to see where we stand." }, test], usage(2200, 52000, 900)),
  user(T0 + 52_000, [result(test, ' ✓ src/pears/score.test.ts (4 tests) 3ms\n\n Test Files  1 passed (1)\n      Tests  4 passed (4)')]),
  say(T0 + 90_000, [{ type: 'text', text: "Written and tested. One thing the build found:" }, fail], usage(900, 60000, 700)),
  user(T0 + 99_000, [result(fail, "src/pears/game.ts(41,7): error TS2322: Type 'string' is not assignable to type 'number'.", true)]),
  say(T0 + 120_000, [{ type: 'text', text: "Fixed the type (`ripeness` is a number, not a label), and the build passes. The game is in `src/pears/game.ts`, scored by `pearScore`, with a combo bonus for consecutive ripe taps." }], usage(600, 64000, 300)),
]);

// ── workflow runs ──
const runs = [
  { run: 'wf_review-pears', name: 'review-pears', desc: 'Review the pear game across dimensions', at: now - 2.6 * 86400_000, status: 'completed', phases: ['Review', 'Verify'], agents: [['Review', 'Review the game loop for bugs'], ['Review', 'Review scoring for edge cases'], ['Review', 'Review the UI for phone widths'], ['Verify', 'Verify finding: combo overflows'], ['Verify', 'Verify finding: tap target too small']] },
  { run: 'wf_fix-flaky', name: 'fix-flaky-tests', desc: 'Find and fix flaky tests', at: now - 1.1 * 86400_000, status: 'completed', phases: ['Find', 'Fix'], agents: [['Find', 'Run the suite ten times and list the flaky ones'], ['Fix', 'Fix the timer test'], ['Fix', 'Fix the seed test']] },
  { run: 'wf_scout-art', name: 'scout-art', desc: 'Pick pear artwork', at: now - 9 * 3600_000, status: 'completed', phases: ['Search', 'Pick'], agents: [['Search', 'Search for ripe pear photos'], ['Search', 'Search for pear illustrations'], ['Pick', 'Pick three and say why']] },
  { run: 'wf_polish', name: 'polish-pass', desc: 'A last polish pass over the game', at: now - 4 * 60_000, status: 'running', phases: ['Polish'], agents: [['Polish', 'Tidy the score animation'], ['Polish', 'Check the focus order']] },
];
for (const r of runs) {
  const running = r.status === 'running';
  let tools = 0;
  let tokens = 0;
  r.agents.forEach(([phase, desc], i) => {
    const aid = `agent-${r.run.slice(3, 9)}${i}a`;
    const file = path.join(sdir, 'subagents', 'workflows', r.run, aid + '.jsonl');
    const t = r.at + i * 40_000;
    const call = use('Read', { file_path: `/home/dev/orchard/src/pears/${i % 2 ? 'score' : 'game'}.ts` });
    const call2 = use('Grep', { pattern: 'TODO', path: 'src' });
    tools += 2;
    tokens += 5200;
    put(file, [
      user(t, `${desc}. Report what you found in a few lines.`),
      say(t + 5_000, [{ type: 'text', text: 'Reading the file first.' }, call], usage(500, 30000, 800)),
      user(t + 7_000, [result(call, '// …the file…')]),
      say(t + 20_000, [call2], usage(300, 32000, 200)),
      user(t + 22_000, [result(call2, 'no matches')]),
      say(t + 34_000, [{ type: 'text', text: `${desc}: nothing alarming. One small suggestion, noted for the summary.` }], usage(700, 33000, 100)),
    ]);
    fs.writeFileSync(file.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: desc, spawnDepth: 1, finished: !running, model: MODEL, workflowPhase: phase }));
  });
  fs.mkdirSync(path.join(sdir, 'workflows'), { recursive: true });
  fs.writeFileSync(
    path.join(sdir, 'workflows', r.run + '.json'),
    JSON.stringify({
      runId: r.run,
      workflowName: r.name,
      status: r.status,
      phases: r.phases.map((title) => ({ title })),
      agentCount: r.agents.length,
      durationMs: r.agents.length * 40_000 + 30_000,
      totalTokens: tokens,
      totalToolCalls: tools,
      summary: running ? '' : `${r.agents.length} agents finished; nothing blocking.`,
      startTime: r.at,
      script: `export const meta = {\n  name: '${r.name}',\n  description: '${r.desc}',\n  phases: [${r.phases.map((p) => `{ title: '${p}' }`).join(', ')}],\n}\nconst results = await pipeline(PHASES, (p) => agent(p.prompt, { phase: p.title }))\nreturn { results }\n`,
      result: running ? undefined : { ok: true, findings: r.agents.length },
    }),
  );
}
console.log(`made ${root}`);
