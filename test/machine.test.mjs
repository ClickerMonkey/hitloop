// The machine dashboard: round-robin files, reading Claude Code's transcripts (tokens counted once per reply, tool
// durations, agents, workflows), and the hub's api/machine routes (off until on, pause). Runs against dist/.
import { test as nodeTest, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const test = (name, fn) => nodeTest(name, { timeout: 60_000 }, fn);

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hitl-m-')));
process.env.HITL_HOME = path.join(tmp, 'home');
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
delete process.env.HITL_CONFIG;

const { Rrd, TIERS } = await import('../dist/machine/rrd.js');
const { ClaudeReader } = await import('../dist/machine/claude.js');
const { costOf, priceOf } = await import('../dist/machine/prices.js');
const { start } = await import('../dist/server.js');

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('a gauge keeps the average and maximum of each slot, and survives a restart', () => {
  const dir = path.join(tmp, 'rrd1');
  const r = new Rrd(dir);
  const t0 = Math.floor(Date.now() / 5000) * 5000 - 60_000;
  r.gauge('cpu', t0, 10);
  r.gauge('cpu', t0 + 1000, 30);
  r.gauge('cpu', t0 + 5000, 50);
  r.close();
  const again = new Rrd(dir);
  const read = again.read('cpu', 3600, t0 + 6000);
  assert.equal(read.step, 5);
  const vs = read.v.filter((v) => v !== null);
  assert.deepEqual(vs, [20, 50]);
  assert.deepEqual(read.max.filter((v) => v !== null), [30, 50]);
  // the gap before and after is empty, not zero
  assert.ok(read.v.includes(null));
  again.close();
});

test('a count adds up, also at past times, and the coarser tiers hold what the fine ones dropped', () => {
  const r = new Rrd(path.join(tmp, 'rrd2'));
  const now = Date.now();
  r.add('tok', now, 5);
  r.add('tok', now - 3 * 86400_000, 7); // older than the 1-minute ring: the 10-minute and hourly ones keep it
  r.add('tok', now, 1);
  assert.equal(r.total('tok', 3600, now), 6);
  assert.equal(r.total('tok', 7 * 86400, now), 13);
  // a week comes from the 10-minute ring, merged so a graph gets at most about 800 points
  const wk = r.read('tok', 7 * 86400, now);
  assert.equal(wk.step % TIERS[2].step, 0);
  assert.ok(wk.v.length <= 800);
  r.close();
  // the file never grows past its fixed size
  const size = fs.statSync(path.join(tmp, 'rrd2', fs.readdirSync(path.join(tmp, 'rrd2')).find((f) => f.endsWith('.rrd')))).size;
  assert.equal(size, 64 + TIERS.reduce((n, t) => n + t.n, 0) * 4);
});

test('prices: known models, an unknown one costs nothing, fast mode doubles', () => {
  assert.equal(priceOf('claude-opus-5-5').input, 4);
  assert.equal(priceOf('claude-haiku-4-5-20251001').output, 5);
  assert.equal(priceOf('gpt-x'), undefined);
  const u = { input: 1e6, output: 1e6, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
  assert.equal(costOf('claude-sonnet-5-5', u), 12);
  assert.equal(costOf('claude-sonnet-5-5', u, true), 24);
  assert.equal(costOf('gpt-x', u), 0);
});

// a small ~/.claude: one session with a reply written as two lines, a tool call and its result, a subagent and a
// workflow run
function fixture() {
  const home = process.env.CLAUDE_CONFIG_DIR;
  const proj = path.join(home, 'projects', 'E--work-app');
  const sid = 'sess-1';
  const t = (s) => new Date(Date.now() - 3600_000 + s * 1000).toISOString();
  const usage = (out) => ({ input_tokens: 10, output_tokens: out, cache_read_input_tokens: 1000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 200 }, output_tokens_details: { thinking_tokens: 3 } });
  const lines = [
    { type: 'custom-title', customTitle: 'Fix the login page', sessionId: sid },
    { parentUuid: null, type: 'user', cwd: 'E:\\work\\app', gitBranch: 'main', version: '2.1.0', timestamp: t(0), message: { role: 'user', content: 'fix it' } },
    { type: 'api-request-blob', huge: 'x'.repeat(1000) },
    { parentUuid: 'a', type: 'assistant', cwd: 'E:\\work\\app', timestamp: t(1), message: { id: 'msg_1', model: 'claude-opus-5-5', usage: usage(5), content: [{ type: 'thinking', thinking: '' }] } },
    { parentUuid: 'b', type: 'assistant', cwd: 'E:\\work\\app', timestamp: t(2), message: { id: 'msg_1', model: 'claude-opus-5-5', usage: usage(20), content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } }] } },
    { parentUuid: 'c', type: 'user', timestamp: t(9), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: 'boom' }] } },
  ];
  fs.mkdirSync(path.join(proj, sid, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(proj, `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const agent = [{ parentUuid: null, isSidechain: true, type: 'assistant', timestamp: t(4), message: { id: 'msg_a', model: 'claude-haiku-5-5', usage: usage(7), content: [] } }];
  fs.writeFileSync(path.join(proj, sid, 'subagents', 'agent-abc.jsonl'), agent.map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.writeFileSync(path.join(proj, sid, 'subagents', 'agent-abc.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Find the login code', spawnDepth: 1, finished: true, model: 'claude-haiku-5-5' }));
  fs.mkdirSync(path.join(proj, sid, 'workflows'), { recursive: true });
  fs.writeFileSync(
    path.join(proj, sid, 'workflows', 'wf_1.json'),
    JSON.stringify({ runId: 'wf_1', workflowName: 'review-login', status: 'completed', phases: [{ title: 'Review' }], agentCount: 2, durationMs: 60000, totalTokens: 12345, totalToolCalls: 9, summary: 'Review the login', script: "export const meta = {\n  name: 'review-login',\n  description: 'Review the login',\n}\n", result: { ok: true }, startTime: Date.now() - 1800_000 }),
  );
  return sid;
}

test('transcripts: a reply counts once, tool calls get durations and failures, agents and workflows are found', async () => {
  const sid = fixture();
  const rrd = new Rrd(path.join(tmp, 'rrd3'));
  const reader = new ClaudeReader(rrd, path.join(tmp, 'claude-state'), () => undefined);
  reader.start();
  // wait for everything it checks (the whole suite runs at once, so this can take a while)
  const ready = () => {
    const s = reader.get(sid);
    return reader.progress.finishedAt && s?.workflows?.wf_1 && s?.agents?.['agent-abc']?.turns && s.tok.out === 27 && s.toolErr === 1 && s.title && s.prompts === 1;
  };
  const until = Date.now() + 45_000;
  while (Date.now() < until && !ready()) await new Promise((r) => setTimeout(r, 100));
  const s = reader.get(sid);
  assert.ok(s, 'the session was read');
  assert.equal(s.title, 'Fix the login page');
  assert.equal(s.project, 'app');
  assert.equal(s.branch, 'main');
  assert.equal(s.prompts, 1);
  // two lines of msg_1 (5 then 20 written) plus the agent's 7: 27, not 32
  assert.equal(s.tok.out, 27);
  assert.equal(s.tok.cread, 2000);
  assert.equal(s.tok.cw1h, 400);
  assert.equal(s.turns, 2);
  assert.equal(s.tools, 1);
  assert.equal(s.toolErr, 1);
  assert.equal(s.ctx.length, 1);
  assert.equal(s.ctx[0][1], 1210);
  const a = s.agents['agent-abc'];
  assert.equal(a.type, 'Explore');
  assert.equal(a.description, 'Find the login code');
  assert.equal(a.tok.out, 7);
  assert.equal(a.finished, true);
  const w = s.workflows.wf_1;
  assert.equal(w.name, 'review-login');
  assert.equal(w.totalTokens, 12345);
  assert.equal(w.description, 'Review the login');
  assert.equal(reader.workflow(sid, 'wf_1').script.includes('review-login'), true);
  const bash = reader.toolStats(86400).find((x) => x.name === 'Bash');
  assert.equal(bash.n, 1);
  assert.equal(bash.err, 1);
  assert.equal(bash.max, 7000);
  assert.equal(reader.recentCalls()[0].summary, 'npm test');
  assert.equal(rrd.total('cl.out', 86400), 27);
  assert.equal(rrd.total('cl.tools', 86400), 1);
  assert.ok(rrd.total('cl.cost', 86400) > 0);
  assert.ok(rrd.has('cl.m.claude-haiku-5-5.tok'));
  assert.ok(rrd.has('cl.p.app.tok'));
  // read again from saved offsets: nothing counted twice
  reader.stop();
  const reader2 = new ClaudeReader(rrd, path.join(tmp, 'claude-state'), () => undefined);
  reader2.start();
  const until2 = Date.now() + 30_000;
  while (Date.now() < until2 && !reader2.progress.finishedAt) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(reader2.get(sid).tok.out, 27);
  assert.equal(rrd.total('cl.out', 86400), 27);
  reader2.stop();
  rrd.close();
});

test('api/machine: off until turned on, then pause and resume', async () => {
  const hub = await start({ mode: 'hub', projects: () => [], port: 0, host: '127.0.0.1', settings: () => ({}) });
  const url = (p) => `http://127.0.0.1:${hub.port}/${p}`;
  const get = async (p) => (await fetch(url(p))).json();
  const post = async (p, body) => (await fetch(url(p), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  try {
    let st = await get('api/machine');
    assert.equal(st.on, false);
    assert.equal(st.running, false);
    st = await post('api/machine', { on: true });
    assert.equal(st.on, true);
    assert.equal(st.running, true);
    st = await post('api/machine', { pause: '1h' });
    assert.equal(st.running, false);
    assert.equal(st.paused.kind, '1h');
    assert.ok(st.paused.until > Date.now());
    st = await post('api/machine', { pause: 'restart' });
    assert.equal(st.paused.kind, 'restart');
    st = await post('api/machine', { pause: 'off' });
    assert.equal(st.paused, null);
    assert.equal(st.running, true);
    const bad = await fetch(url('api/machine'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pause: 'forever' }) });
    assert.equal(bad.status, 400);
    const series = await get('api/machine/series?n=sys.cpu&range=3600');
    assert.ok('sys.cpu' in series.series);
    const now = await get('api/machine/now');
    assert.ok(Array.isArray(now.live));
    st = await post('api/machine', { on: false });
    assert.equal(st.running, false);
    // the setting is kept in the user's config
    const cfg = JSON.parse(fs.readFileSync(path.join(process.env.HITL_HOME, 'config.json'), 'utf8'));
    assert.equal(cfg.machine.on, false);
  } finally {
    await hub.close();
  }
});
