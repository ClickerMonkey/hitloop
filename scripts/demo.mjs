// Makes a demo project that uses everything hitl does: a git repository with changes (Trailhead), a
// question set (a weather plan), reviews with every kind of item, something just to look at, an approval
// waiting, notes on files with the agent's replies, and some feedback already given.
//   node scripts/demo.mjs <folder>          (needs a build: npm run build)
//   HITL_HOME=<folder>/.home node dist/cli.js --solo <folder> --local
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { makeDemo as makeRepo } from './demo-repo.mjs';
import { makeDemo as makeQuestions } from './demo-questions.mjs';
import { Reviews } from '../dist/r/store.js';
import { Questions } from '../dist/q/store.js';
import { Notes } from '../dist/fs/notes.js';

function png(w, h, paint) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(paint(x, y), y * (w * 3 + 1) + 1 + x * 3);
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b) => {
    let c = -1;
    for (const x of b) c = table[(c ^ x) & 255] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ih = Buffer.alloc(13);
  ih.writeUInt32BE(w, 0);
  ih.writeUInt32BE(h, 4);
  ih[8] = 8;
  ih[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** a phone screenshot of the trail page: header, a hero picture, cards; `fixed` moves the button and evens the gaps */
function screen(fixed) {
  const W = 360,
    H = 640;
  return png(W, H, (x, y) => {
    if (y < 56) return [91, 95, 214];
    if (y < 236) return [Math.round(120 + (x / W) * 60), Math.round(170 - (y / 236) * 40), 200];
    const cardTop = fixed ? 252 : 262;
    for (let i = 0; i < 3; i++) {
      const top = cardTop + i * (fixed ? 104 : 96 + i * 8);
      if (y >= top && y < top + 84 && x >= 16 && x < W - 16) return y < top + 4 ? [235, 236, 242] : [255, 255, 255];
    }
    const bx = fixed ? 16 : 200;
    if (y >= 576 && y < 616 && x >= bx && x < bx + (fixed ? W - 32 : 144)) return [46, 160, 90];
    return [244, 245, 249];
  });
}

export function makeDemo(root) {
  root = path.resolve(root);
  makeRepo(root);
  makeQuestions(root);
  const q = new Questions(root);
  const r = new Reviews(root);
  const notes = new Notes(path.join(root, '.hitl', 'notes'), root);
  fs.mkdirSync(path.join(root, 'screens'), { recursive: true });
  fs.writeFileSync(path.join(root, 'screens', 'trail-before.png'), screen(false));
  fs.writeFileSync(path.join(root, 'screens', 'trail-after.png'), screen(true));

  // a review of real work: the retry change, as files, a diff against HEAD, proposed config, pictures
  const review = r.create(
    {
      title: 'Retry flaky trail lookups',
      intro: 'I added `withRetry` and used it for `/trails`, which fails now and then when the data source is slow. Please look at each part; **the error body** (item 2) is the one I am least sure about.',
      mode: 'review',
      from: 'Claude · branch retry-lookups',
    },
    [
      { file: 'src/lib/retry.ts', title: 'The retry helper', note: 'Backs off 200 ms, 400 ms, then gives up. Is three tries right?', ask: 'Is the backoff sensible?' },
      { file: 'src/server.ts', against: 'HEAD', title: 'Where it is used', note: 'Also: unknown paths now answer JSON instead of plain text.' },
      {
        code: '{\n  "cacheSize": 100,\n  "retry": { "tries": 3, "baseMs": 100 }\n}\n',
        before: '{\n  "cacheSize": 100\n}\n',
        lang: 'json',
        name: 'config.json',
        title: 'Proposed config',
        note: 'Not written yet: this is what I would add.',
      },
      { image: 'screens/trail-after.png', before: 'screens/trail-before.png', title: 'The trail page, before and after', note: 'Cards evenly spaced; the button is full width now.', ask: 'Better?' },
      {
        mermaid: 'sequenceDiagram\n  participant P as Page\n  participant S as Server\n  participant D as Data\n  P->>S: GET /trails\n  S->>D: list (try 1)\n  D--xS: timeout\n  S->>D: list (try 2, after 200 ms)\n  D-->>S: trails\n  S-->>P: 200 JSON',
        title: 'How a retry goes',
      },
      { md: '## Not in this change\n\n- Retrying writes (they are not idempotent yet).\n- A circuit breaker: later, if retries pile up.\n\n> [!NOTE]\n> The cache still sits in front of all of this.', title: 'What I left out' },
    ],
  );
  r.verdict(review.id, 'the-retry-helper', 'ok', '');
  r.verdict(review.id, 'proposed-config', 'changes', 'Call it maxTries, and read it from the env like CACHE_SIZE.');
  const c = r.comment(review.id, { item: 'the-retry-helper', line: 6, body: 'Log the attempt number here, so we can see how often it retries.', quote: '      if (i >= tries) throw err;' });
  r.reply(review.id, c.id, 'agent', 'Good idea: I will log `retry ${i} of ${tries}` at debug level.');
  r.comment(review.id, { item: 'where-it-is-used', line: 12, body: 'Should the 404 body say which path?' });

  // something just to look at
  r.create(
    {
      title: 'Screenshots of the new trail page',
      intro: 'From the phone emulator, at 360 × 640. Nothing to decide: say if anything looks off.',
      mode: 'show',
      from: 'Claude · branch trail-page',
    },
    [
      { image: 'screens/trail-after.png', title: 'Trail page', alt: 'The trail page on a phone' },
      { file: 'assets/dawn.png', title: 'The hero picture' },
      { html: '<div style="font:15px system-ui;padding:20px"><h2 style="margin:0 0 8px">Ridge Loop</h2><p style="margin:0;color:#666">6.2 mi · 1,140 ft climb · Moderate</p><button style="margin-top:16px;width:100%;padding:12px;border:0;border-radius:10px;background:#2ea05a;color:#fff;font:600 15px system-ui">Start the trail</button></div>', height: 180, title: 'The card, as HTML' },
    ],
  );

  // an approval: the agent is waiting at the gate
  r.create(
    {
      title: 'Deploy Trailhead 1.3 to production?',
      intro: "**What happens:** the image is built, pushed, and the service restarts (about 20 s of 503s).\n\n**Undo:** `deploy rollback 1.2.4`.\n\nThe retry change is in it; the config change isn't.",
      mode: 'approve',
      from: 'Claude · release',
    },
    [{ diff: "--- a/package.json\n+++ b/package.json\n@@ -1,5 +1,5 @@\n {\n   \"name\": \"trailhead\",\n-  \"version\": \"1.2.4\",\n+  \"version\": \"1.3.0\",\n   \"type\": \"module\",\n", title: 'The version bump' }],
  );

  // notes from the human on the files, one answered by the agent
  const n1 = notes.add({ path: 'src/lib/cache.ts', line: 3, endLine: 5, body: 'This never evicts: can it keep the newest 100?', author: 'Phil' });
  notes.reply(n1.id, 'agent', 'It does evict, in set(): the oldest key goes when it is full. I added a comment saying so.', 'agent');
  notes.add({ path: '', body: 'The README should say how to run the tests.', author: 'Phil' });

  // some answers already given
  q.answer('weather-plan', 'platform', { picked: ['web'], note: 'Phones first.' });
  return root;
}

if (process.argv[1]?.endsWith('demo.mjs')) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: node scripts/demo.mjs <folder>');
    process.exit(1);
  }
  makeDemo(dir);
  console.log(`demo project in ${path.resolve(dir)}\n  HITL_HOME=${path.resolve(dir, '..', '.hitl-home')} node dist/cli.js --solo ${dir} --local`);
}
