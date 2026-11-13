// Exception support: stack frames from each engine, `$exception` construction, the client's repeat and launch
// caps, and `reportErrors`. The harness is duplicated from posthog.test.ts: a loopback PostHog in `Bun.serve`.
import { afterAll, beforeEach, expect, test } from 'bun:test';
import {
  DEFAULT_LIB,
  exceptionFrom,
  EXCEPTION_REPEAT_MS,
  FRAMES_MAX,
  framesFromStack,
  openPostHog,
  reportErrors,
  type Exception,
  type ExceptionFrame,
  type PostHogIO,
} from '../index.ts';

type Events = Record<string, Record<string, unknown>>;
type Seen = { path: string; body: any };
let seen: Seen[] = [];
let status = 200;
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    seen.push({ path: url.pathname + url.search, body: await request.json() });
    if (status !== 200) return new Response('no', { status });
    return Response.json({ status: 1 });
  },
});
afterAll(() => server.stop(true));
const HOST = `http://127.0.0.1:${server.port}`;
const KEY = 'phc_test';
const AT = Date.UTC(2026, 10, 11, 12, 0, 0);

beforeEach(() => {
  seen = [];
  status = 200;
});

function io(initial?: string): PostHogIO & { file: () => string | undefined } {
  let file = initial;
  let n = 0;
  return {
    fetch: (url, init) => fetch(url, init),
    read: async () => file,
    write: async (text) => {
      file = text;
    },
    uuid: () => `install-${++n}`,
    file: () => file,
  };
}

const open = (store: PostHogIO, extra: { lib?: string; exceptionMax?: number; exceptionRepeatMs?: number } = {}) =>
  openPostHog<Events>({ key: KEY, host: HOST, ...extra }, store);

// A whole request as the client sends it: one batch, each event carrying the install id.
const request = (...events: object[]) => ({
  path: '/batch/',
  body: {
    api_key: KEY,
    batch: events.map((event) => ({ ...event, distinct_id: 'install-1' })),
  },
});

const exceptionOf = (type: string, value: string, handled = true, frames?: ExceptionFrame[]): Exception => ({
  type,
  value,
  mechanism: { handled, synthetic: false },
  ...(frames ? { stacktrace: { type: 'raw' as const, frames } } : {}),
});

const exceptionEvent = (exception: Exception, at: number | undefined) => ({
  event: '$exception',
  properties: { $exception_list: [exception], $lib: DEFAULT_LIB, $process_person_profile: true },
  ...(at === undefined ? {} : { timestamp: new Date(at).toISOString() }),
});

const lifecycleEvent = (name: string, at: number) => ({
  event: name,
  properties: { $lib: DEFAULT_LIB, $process_person_profile: true },
  timestamp: new Date(at).toISOString(),
});

// The real stack Exact's macOS host produced for a TypeError thrown in its data code.
const HERMES_STACK = `TypeError: probe boom
    at outer (app.js:32:22)
    at ?anon_0_ (app.js:53:10)
    at next (native)
    at tryCallTwo (address at InternalBytecode.js:1:27653)
    at greeting (app.js:66:21)
    at anonymous (/private/tmp/exact-errprobe/target/aarch64-apple-darwin/host-dev/build/exact-js-3015836f9259c27d/out/prelude.js:3482:124)`;

// Outermost first, as PostHog reads them: the prelude frame was the innermost on the stack.
const HERMES_FRAMES: ExceptionFrame[] = [
  { platform: 'custom', lang: 'javascript', function: 'anonymous', filename: 'prelude.js', lineno: 3482, colno: 124, in_app: false, resolved: false },
  { platform: 'custom', lang: 'javascript', function: 'greeting', filename: 'app.js', lineno: 66, colno: 21, in_app: true, resolved: false },
  { platform: 'custom', lang: 'javascript', function: 'tryCallTwo', filename: 'InternalBytecode.js', lineno: 1, colno: 27653, in_app: false, resolved: false },
  { platform: 'custom', lang: 'javascript', function: 'next', in_app: false, resolved: false },
  { platform: 'custom', lang: 'javascript', function: '?anon_0_', filename: 'app.js', lineno: 53, colno: 10, in_app: true, resolved: false },
  { platform: 'custom', lang: 'javascript', function: 'outer', filename: 'app.js', lineno: 32, colno: 22, in_app: true, resolved: false },
];

const hermesException = (handled: boolean): Exception => ({
  type: 'TypeError',
  value: 'probe boom',
  mechanism: { handled, synthetic: false },
  stacktrace: { type: 'raw', frames: HERMES_FRAMES },
});

test('framesFromStack reads a Hermes stack outermost first, with Exact runtime files kept out of the app', () => {
  expect(framesFromStack(HERMES_STACK)).toEqual(HERMES_FRAMES);
});

test('framesFromStack reads a V8 stack, never takes its message for a frame, and strips query strings', () => {
  const stack = `TypeError: bad user@example.com
    at xd (http://127.0.0.1:56522/.exact/gen/b5a1/app.js?v=2:6:22153)
    at Generator.next (<anonymous>)
    at http://127.0.0.1:56522/.exact/gen/b5a1/app.js:6:22113
    at async Promise.all (index 0)`;
  const frames = framesFromStack(stack);
  expect(frames).toEqual([
    { platform: 'custom', lang: 'javascript', function: 'async Promise.all', in_app: false, resolved: false },
    { platform: 'custom', lang: 'javascript', function: '?', filename: 'app.js', lineno: 6, colno: 22113, in_app: true, resolved: false },
    { platform: 'custom', lang: 'javascript', function: 'Generator.next', in_app: false, resolved: false },
    { platform: 'custom', lang: 'javascript', function: 'xd', filename: 'app.js', lineno: 6, colno: 22153, in_app: true, resolved: false },
  ]);
  expect(JSON.stringify(frames)).not.toContain('example.com');
  expect(frames.filter((frame) => frame.filename !== undefined).map((frame) => frame.filename)).toEqual(['app.js', 'app.js']);
});

test('framesFromStack reads a JavaScriptCore stack outermost first', () => {
  const stack = `inner@file:///var/x/app.js:3:9
outer@file:///var/x/app.js:6:5
forEach@[native code]
@file:///var/x/app.js:9:1`;
  expect(framesFromStack(stack)).toEqual([
    { platform: 'custom', lang: 'javascript', function: '?', filename: 'app.js', lineno: 9, colno: 1, in_app: true, resolved: false },
    { platform: 'custom', lang: 'javascript', function: 'forEach', in_app: false, resolved: false },
    { platform: 'custom', lang: 'javascript', function: 'outer', filename: 'app.js', lineno: 6, colno: 5, in_app: true, resolved: false },
    { platform: 'custom', lang: 'javascript', function: 'inner', filename: 'app.js', lineno: 3, colno: 9, in_app: true, resolved: false },
  ]);
});

test('framesFromStack keeps exactly the innermost FRAMES_MAX frames', () => {
  const stack = Array.from({ length: FRAMES_MAX + 10 }, (_, i) => `    at f${i} (app.js:${i + 1}:1)`).join('\n');
  const frames = framesFromStack(stack);
  // f0 is the innermost and first on the stack; it is last in the sent array.
  expect(frames).toEqual(
    Array.from({ length: FRAMES_MAX }, (_, i) => ({
      platform: 'custom',
      lang: 'javascript',
      function: `f${FRAMES_MAX - 1 - i}`,
      filename: 'app.js',
      lineno: FRAMES_MAX - i,
      colno: 1,
      in_app: true,
      resolved: false,
    })),
  );
  expect(frames.at(-1)!.function).toBe('f0');
});

test("exceptionFrom reads an Error's name, message, mechanism and raw frames", () => {
  const exception = exceptionFrom(new RangeError('too far'), true);
  expect(exception).toEqual({
    type: 'RangeError',
    value: 'too far',
    mechanism: { handled: true, synthetic: false },
    stacktrace: { type: 'raw', frames: expect.any(Array) },
  });
  expect(exception.stacktrace!.frames.length).toBeGreaterThan(0);
});

test('exceptionFrom leaves the stacktrace out when an object has a message but no stack', () => {
  expect(exceptionFrom({ message: 'plain' }, true)).toEqual({
    type: 'Error',
    value: 'plain',
    mechanism: { handled: true, synthetic: false },
  });
});

test('exceptionFrom sends a thrown string as a synthetic Error', () => {
  expect(exceptionFrom('boom', true)).toEqual({
    type: 'Error',
    value: 'boom',
    mechanism: { handled: true, synthetic: true },
  });
});

test("exceptionFrom never puts a thrown object's own fields in the exception", () => {
  const exception = exceptionFrom({ email: 'a@b.c' }, true);
  expect(exception).toEqual({
    type: 'Error',
    value: 'Non-error thrown: object',
    mechanism: { handled: true, synthetic: true },
  });
  expect(JSON.stringify(exception)).not.toContain('a@b.c');
});

test('exceptionFrom names null and an object whose message getter throws as non-errors', () => {
  expect(exceptionFrom(null, true)).toEqual({
    type: 'Error',
    value: 'Non-error thrown: null',
    mechanism: { handled: true, synthetic: true },
  });
  const trap = {
    get message(): string {
      throw new Error('no message for you');
    },
  };
  expect(exceptionFrom(trap, true)).toEqual({
    type: 'Error',
    value: 'Non-error thrown: object',
    mechanism: { handled: true, synthetic: true },
  });
});

test('captureException sends one unhandled $exception at its time, with its frames', async () => {
  const client = (await open(io()))!;
  const error = new TypeError('probe boom');
  error.stack = HERMES_STACK;
  await client.captureException(error, AT, { handled: false });
  expect(seen).toEqual([request(exceptionEvent(hermesException(false), AT))]);
});

test('captureException treats a caught error as handled by default', async () => {
  const client = (await open(io()))!;
  const error = new TypeError('probe boom');
  error.stack = HERMES_STACK;
  await client.captureException(error, AT);
  expect(seen).toEqual([request(exceptionEvent(hermesException(true), AT))]);
});

test('captureException without an at leaves the timestamp off the event', async () => {
  const client = (await open(io()))!;
  await client.captureException({ message: 'no time' });
  expect(seen).toEqual([request(exceptionEvent(exceptionOf('Error', 'no time'), undefined))]);
});

test('captureException sends the same type and message once per repeat window', async () => {
  const client = (await open(io()))!;
  await client.captureException({ message: 'same' }, AT);
  await client.captureException({ message: 'same' }, AT + 1000);
  expect(seen).toEqual([request(exceptionEvent(exceptionOf('Error', 'same'), AT))]);
  await client.captureException({ message: 'same' }, AT + EXCEPTION_REPEAT_MS);
  expect(seen).toEqual([
    request(exceptionEvent(exceptionOf('Error', 'same'), AT)),
    request(exceptionEvent(exceptionOf('Error', 'same'), AT + EXCEPTION_REPEAT_MS)),
  ]);
});

test('captureException sends a different message inside the same repeat window', async () => {
  const client = (await open(io()))!;
  await client.captureException({ message: 'first' }, AT);
  await client.captureException({ message: 'second' }, AT + 1000);
  expect(seen).toEqual([
    request(exceptionEvent(exceptionOf('Error', 'first'), AT)),
    request(exceptionEvent(exceptionOf('Error', 'second'), AT + 1000)),
  ]);
});

test('captureException drops a repeat when there is no at to compare', async () => {
  const client = (await open(io()))!;
  await client.captureException({ message: 'unclocked' });
  await client.captureException({ message: 'unclocked' });
  expect(seen).toEqual([request(exceptionEvent(exceptionOf('Error', 'unclocked'), undefined))]);
});

test('captureException sends a stamped repeat of an error first sent without a time', async () => {
  const client = (await open(io()))!;
  await client.captureException({ message: 'late clock' });
  await client.captureException({ message: 'late clock' }, AT);
  await client.captureException({ message: 'late clock' }, AT + 1000);
  expect(seen).toEqual([
    request(exceptionEvent(exceptionOf('Error', 'late clock'), undefined)),
    request(exceptionEvent(exceptionOf('Error', 'late clock'), AT)),
  ]);
});

test('captureException honours a custom exceptionRepeatMs', async () => {
  const client = (await open(io(), { exceptionRepeatMs: 10 }))!;
  await client.captureException({ message: 'quick' }, AT);
  await client.captureException({ message: 'quick' }, AT + 5);
  expect(seen).toEqual([request(exceptionEvent(exceptionOf('Error', 'quick'), AT))]);
  await client.captureException({ message: 'quick' }, AT + 10);
  expect(seen).toEqual([
    request(exceptionEvent(exceptionOf('Error', 'quick'), AT)),
    request(exceptionEvent(exceptionOf('Error', 'quick'), AT + 10)),
  ]);
});

test('captureException sends at most exceptionMax exceptions in one launch', async () => {
  const client = (await open(io(), { exceptionMax: 3 }))!;
  for (let i = 0; i < 5; i++) await client.captureException({ message: `m${i}` }, AT + i);
  expect(seen).toEqual([
    request(exceptionEvent(exceptionOf('Error', 'm0'), AT)),
    request(exceptionEvent(exceptionOf('Error', 'm1'), AT + 1)),
    request(exceptionEvent(exceptionOf('Error', 'm2'), AT + 2)),
  ]);
});

test('captureException sends nothing while opted out and does not use up the launch cap', async () => {
  const client = (await open(io(), { exceptionMax: 1 }))!;
  await client.setEnabled(false);
  await client.captureException({ message: 'hidden' }, AT);
  expect(seen).toEqual([]);
  await client.setEnabled(true);
  await client.captureException({ message: 'shown' }, AT + 1);
  expect(seen).toEqual([request(exceptionEvent(exceptionOf('Error', 'shown'), AT + 1))]);
});

test('a failed exception send goes with the next event, the exception first', async () => {
  const client = (await open(io()))!;
  status = 503;
  await client.captureException({ message: 'offline' }, AT);
  expect(seen).toEqual([request(exceptionEvent(exceptionOf('Error', 'offline'), AT))]);
  seen = [];
  status = 200;
  await client.lifecycle('Application Opened', AT + 1000);
  expect(seen).toEqual([
    request(
      exceptionEvent(exceptionOf('Error', 'offline'), AT),
      lifecycleEvent('Application Opened', AT + 1000),
    ),
  ]);
  expect(seen[0]!.body.batch.map((event: any) => event.event)).toEqual(['$exception', 'Application Opened']);
});

test("reportErrors rejects with the source error after reporting it once with the call's arguments", async () => {
  const order: string[] = [];
  const calls: unknown[][] = [];
  const error = new Error('broken');
  const source = async (count: number, word: string) => {
    order.push('source');
    throw error;
  };
  const wrapped = reportErrors(source, (reported, args) => {
    order.push('report');
    calls.push([reported, ...args]);
  });
  const caught = await wrapped(1, 'two').catch((thrown) => {
    order.push('caught');
    return thrown;
  });
  expect(caught).toBe(error);
  expect(calls).toEqual([[error, 1, 'two']]);
  expect(order).toEqual(['source', 'report', 'caught']);
});

test('reportErrors turns a synchronous throw into a rejection after reporting it', async () => {
  const order: string[] = [];
  const error = new Error('sync');
  const source = (count: number) => {
    order.push('source');
    throw error;
  };
  const wrapped = reportErrors(source, () => {
    order.push('report');
  });
  const result = wrapped(1);
  expect(result).toBeInstanceOf(Promise);
  const caught = await result.catch((thrown) => {
    order.push('caught');
    return thrown;
  });
  expect(caught).toBe(error);
  expect(order).toEqual(['source', 'report', 'caught']);
});

test('reportErrors returns a synchronous value as-is and reports nothing', () => {
  const calls: unknown[] = [];
  const wrapped = reportErrors(
    (a: number, b: number) => a + b,
    (...args) => {
      calls.push(args);
    },
  );
  const result = wrapped(2, 3);
  expect(result).toBe(5);
  expect(result instanceof Promise).toBe(false);
  expect(calls).toEqual([]);
});

test('reportErrors resolves an asynchronous value and reports nothing', async () => {
  const calls: unknown[] = [];
  const wrapped = reportErrors(
    async (value: number) => value * 2,
    () => {
      calls.push('report');
    },
  );
  expect(await wrapped(4)).toBe(8);
  expect(calls).toEqual([]);
});

test('reportErrors skips expected fetch and bake errors unless ignore says otherwise', async () => {
  const calls: unknown[] = [];
  const source = async (error: unknown) => {
    throw error;
  };
  const wrapped = reportErrors(source, (reported) => {
    calls.push(reported);
  });
  const fetchError = Object.assign(new Error('offline'), { name: 'FetchError', kind: 'Network' });
  const bakeError = { code: 'bake' };
  expect(await wrapped(fetchError).catch((thrown) => thrown)).toBe(fetchError);
  expect(await wrapped(bakeError).catch((thrown) => thrown)).toBe(bakeError);
  expect(calls).toEqual([]);
  // `ignore` that names nothing lets both through.
  const reported: unknown[] = [];
  const all = reportErrors(source, (error) => {
    reported.push(error);
  }, () => false);
  expect(await all(fetchError).catch((thrown) => thrown)).toBe(fetchError);
  expect(await all(bakeError).catch((thrown) => thrown)).toBe(bakeError);
  expect(reported).toEqual([fetchError, bakeError]);
});

test('reportErrors keeps the source error when the report throws', async () => {
  const error = new Error('source');
  const wrapped = reportErrors(
    async () => {
      throw error;
    },
    () => {
      throw new Error('report failed');
    },
  );
  expect(await wrapped().catch((thrown) => thrown)).toBe(error);
});

test('reportErrors keeps the source error when the report rejects', async () => {
  const error = new Error('source');
  const wrapped = reportErrors(
    async () => {
      throw error;
    },
    async () => {
      throw new Error('report failed');
    },
  );
  expect(await wrapped().catch((thrown) => thrown)).toBe(error);
});

test('reportErrors does not report an error captureException already reported', async () => {
  const client = (await open(io()))!;
  const error = new Error('already');
  await client.captureException(error, AT);
  seen = [];
  const calls: unknown[] = [];
  const wrapped = reportErrors(
    async () => {
      throw error;
    },
    (reported) => {
      calls.push(reported);
    },
  );
  expect(await wrapped().catch((thrown) => thrown)).toBe(error);
  expect(calls).toEqual([]);
  expect(seen).toEqual([]);
});

test('reportErrors reports an error once through two nested wrappers', async () => {
  const error = new Error('nested');
  const calls: unknown[] = [];
  const report = (reported: unknown) => {
    calls.push(reported);
  };
  const inner = reportErrors(async () => {
    throw error;
  }, report);
  const outer = reportErrors(inner, report);
  expect(await outer().catch((thrown) => thrown)).toBe(error);
  expect(calls).toEqual([error]);
});

test('reportErrors end to end sends one unhandled exception through the client', async () => {
  const client = (await open(io()))!;
  const error = new Error('end to end');
  error.stack = `Error: end to end
    at source (app.js:7:3)`;
  const wrapped = reportErrors(
    async () => {
      throw error;
    },
    (reported) => client.captureException(reported, AT, { handled: false }),
  );
  expect(await wrapped().catch((thrown) => thrown)).toBe(error);
  expect(seen).toEqual([
    request(
      exceptionEvent(
        exceptionOf('Error', 'end to end', false, [
          { platform: 'custom', lang: 'javascript', function: 'source', filename: 'app.js', lineno: 7, colno: 3, in_app: true, resolved: false },
        ]),
        AT,
      ),
    ),
  ]);
});

test('reportErrors passes this and the arguments through untouched', () => {
  const context = { tag: 'ctx' };
  const calls: unknown[] = [];
  const wrapped = reportErrors(
    function (this: { tag: string }, count: number, word: string) {
      return { self: this, args: [count, word] };
    },
    (...args) => {
      calls.push(args);
    },
  );
  const result = wrapped.call(context, 1, 'two') as { self: unknown; args: unknown[] };
  expect(result).toEqual({ self: context, args: [1, 'two'] });
  expect(result.self).toBe(context);
  expect(calls).toEqual([]);
});

test('reportErrors reports a result whose then getter throws, as a rejection', async () => {
  const error = new Error('bad then');
  const calls: unknown[] = [];
  const wrapped = reportErrors(
    () => ({
      get then(): unknown {
        throw error;
      },
    }),
    (reported) => {
      calls.push(reported);
    },
  );
  expect(await (wrapped() as unknown as Promise<unknown>).catch((thrown) => thrown)).toBe(error);
  expect(calls).toEqual([error]);
});
