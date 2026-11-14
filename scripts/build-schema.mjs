// Writes schema/questions.schema.json and schema/reviews.schema.json from the code (via dist/), so the published
// schemas match what hitl checks.
import fs from 'node:fs';
import path from 'node:path';
import { setSchema } from '../dist/q/schema.js';
import { reviewSchema } from '../dist/r/schema.js';

const dir = path.resolve(import.meta.dirname, '..', 'schema');
fs.mkdirSync(dir, { recursive: true });
for (const [name, schema] of [
  ['questions', setSchema],
  ['reviews', reviewSchema],
]) {
  const out = path.join(dir, name + '.schema.json');
  fs.writeFileSync(out, JSON.stringify(schema, null, 2) + '\n');
  console.log('schema: ' + path.relative(process.cwd(), out));
}
