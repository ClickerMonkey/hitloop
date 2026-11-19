// Claude API list prices, US dollars per million tokens, for the dashboard's cost estimate. An estimate only: a
// subscription isn't billed per token, and prices change. Cache writes are 1.25× input (5 minutes) and 2× (1 hour);
// cache reads are the listed price where one is known, else 0.1× input. Fast mode costs twice as much.
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
}

// most specific first: the first prefix that matches wins
const TABLE: [string, number, number, number?][] = [
  ['claude-fable-5-2', 8, 40, 0.2],
  ['claude-mythos-5-2', 8, 40, 0.2],
  ['claude-fable-5-1', 10, 50],
  ['claude-mythos-5-1', 10, 50],
  ['claude-fable-5', 10, 50],
  ['claude-mythos', 10, 50],
  ['claude-opus-5-5', 4, 20, 0.2],
  ['claude-opus-5', 5, 25],
  ['claude-opus-4-8', 5, 25],
  ['claude-opus-4-7', 5, 25],
  ['claude-opus-4-6', 5, 25],
  ['claude-opus-4-5', 5, 25],
  ['claude-opus-4', 15, 75],
  ['claude-sonnet-5-5', 2, 10, 0.1],
  ['claude-sonnet-5', 2, 10],
  ['claude-sonnet-4', 3, 15],
  ['claude-3-7-sonnet', 3, 15],
  ['claude-haiku-5-5', 0.1, 0.5],
  ['claude-haiku-4-5', 1, 5],
  ['claude-3-5-haiku', 0.8, 4],
];

export function priceOf(model: string): Price | undefined {
  const m = model.replace(/^(anthropic\.|us\.anthropic\.)/, '').toLowerCase();
  const row = TABLE.find(([p]) => m.startsWith(p));
  if (!row) return undefined;
  const [, input, output, cacheRead] = row;
  return { input, output, cacheRead: cacheRead ?? input * 0.1 };
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/** what a reply would cost on the API, in dollars (0 for a model we don't know) */
export function costOf(model: string, u: Usage, fast = false): number {
  const p = priceOf(model);
  if (!p) return 0;
  const usd = u.input * p.input + u.output * p.output + u.cacheRead * p.cacheRead + u.cacheWrite5m * p.input * 1.25 + u.cacheWrite1h * p.input * 2;
  return (usd / 1e6) * (fast ? 2 : 1);
}
