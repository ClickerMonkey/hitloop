// Safe writes from many processes at once: an atomic rename, under a lock file.
import fs from 'node:fs';
import path from 'node:path';

export class StoreError extends Error {}

export const stripBom = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

export function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, text);
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      // Windows: a reader holding the file open makes rename fail for a moment
      if (i >= 20) {
        fs.rmSync(tmp, { force: true });
        throw e;
      }
      sleep(25);
    }
  }
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Run fn holding <file>.lock (made with O_EXCL; a lock older than 10 s is taken as abandoned). */
export function withLock<T>(file: string, fn: () => T): T {
  const lock = file + '.lock';
  const until = Date.now() + 8000;
  for (;;) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) fs.rmSync(lock, { force: true });
      } catch {
        // gone already
      }
      if (Date.now() > until) throw new StoreError(`${path.basename(file)} is locked by another process`);
      sleep(15);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}


/** .hitl/README.md: what the folder holds (written once). */
export function ensureReadme(dir: string): void {
  const file = path.join(dir, 'README.md');
  if (fs.existsSync(file)) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, HITL_README);
}

const HITL_README = `# hitl: Human In The Loop

What an agent asked, showed or sent for review in this project, and what the human said back.
Open it with \`npx hitl\` (the links it prints work on a phone too). What's new for the agent: \`npx hitl news\`.

- \`questions/<id>.json\`: question sets (an agent writes these; the format: \`npx hitl schema questions\`).
- \`reviews/<id>.json\`: things shown for review or approval (an agent writes these; \`npx hitl schema reviews\`).
- \`answers/<id>.json\` and \`.md\`: the human's answers, verdicts and comments, one file per question set or review.
- \`notes/\`: notes from the human on files, lines and picture areas (notes.json, NOTES.md, images/).
- \`media/\`: pictures an agent passed as data, and photos the human attached.
`;
