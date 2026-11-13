// The client against a loopback PostHog (Bun.serve): what it sends, what it keeps, and how it reads flags.
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { DEFAULT_LIB, flagsFromResponse, openPostHog, QUEUE_MAX, type PostHogIO } from '../index.ts';

type Events = { opened: { screen: string }; bought: Record<string, never> };
type Seen = { path: string; body: any };
let seen: Seen[] = [];
let flagsReply: unknown = { flags: {} };
let status = 200;
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    seen.push({ path: url.pathname + url.search, body: await request.json() });
    if (status !== 200) return new Response('no', { status });
    return Response.json(url.pathname === '/flags/' ? flagsReply : { status: 1 });
  },
});
afterAll(() => server.stop(true));
const HOST = `http://127.0.0.1:${server.port}`;
const KEY = 'phc_test';
const AT = Date.UTC(2026, 10, 11, 12, 0, 0);

beforeEach(() => {
  seen = [];
  flagsReply = { flags: {} };
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

const open = (store: PostHogIO, extra: { lib?: string; queueMax?: number } = {}) =>
  openPostHog<Events>({ key: KEY, host: HOST, ...extra }, store);

test('without both a key and a host there is no client, and nothing is sent', async () => {
  expect(await openPostHog<Events>({ key: '', host: HOST }, io())).toBeNull();
  expect(await openPostHog<Events>({ key: KEY, host: '' }, io())).toBeNull();
  expect(seen).toEqual([]);
});

test('an install keeps one anonymous id, and an event carries only its own properties', async () => {
  const store = io();
  const client = (await open(store))!;
  expect(client.installed).toBe(true);
  expect(client.installId()).toBe('install-1');
  await client.capture('opened', { screen: 'home' }, AT);
  expect(seen).toEqual([
    {
      path: '/batch/',
      body: {
        api_key: KEY,
        batch: [
          {
            event: 'opened',
            properties: { screen: 'home', $lib: DEFAULT_LIB, $process_person_profile: true },
            timestamp: '2026-11-11T12:00:00.000Z',
            distinct_id: 'install-1',
          },
        ],
      },
    },
  ]);
  // The next launch is the same install.
  const again = (await open(store))!;
  expect(again.installed).toBe(false);
  expect(again.installId()).toBe('install-1');
});

test("an app's own `$lib` names its events, and a trailing slash on the host is dropped", async () => {
  const client = (await openPostHog<Events>({ key: KEY, host: `${HOST}/`, lib: 'my-app' }, io()))!;
  await client.lifecycle('Application Opened', AT);
  expect(seen.map((s) => s.path)).toEqual(['/batch/']);
  expect(seen[0]!.body.batch[0].properties).toEqual({ $lib: 'my-app', $process_person_profile: true });
});

test('an event that cannot be delivered waits for the next, and the queue is bounded', async () => {
  const store = io();
  const client = (await open(store))!;
  status = 503;
  await client.lifecycle('Application Opened', AT);
  status = 200;
  seen = [];
  await client.lifecycle('Application Backgrounded', AT + 1000);
  expect(seen[0]!.body.batch.map((e: any) => e.event)).toEqual(['Application Opened', 'Application Backgrounded']);
  // Delivered: nothing kept.
  expect(JSON.parse(store.file()!).queue).toEqual([]);
  status = 503;
  for (let i = 0; i < QUEUE_MAX + 5; i++) await client.lifecycle('Application Became Active', AT + i);
  expect(JSON.parse(store.file()!).queue.length).toBe(QUEUE_MAX);
  // An app may keep fewer.
  const small = io();
  const few = (await open(small, { queueMax: 3 }))!;
  for (let i = 0; i < 5; i++) await few.lifecycle('Application Became Active', AT + i);
  expect(JSON.parse(small.file()!).queue.map((e: any) => e.timestamp)).toEqual([
    '2026-11-11T12:00:00.002Z',
    '2026-11-11T12:00:00.003Z',
    '2026-11-11T12:00:00.004Z',
  ]);
});

test('an opted-out install sends no events but still reads its flags', async () => {
  const store = io();
  const client = (await open(store))!;
  await client.setEnabled(false);
  expect(client.enabled()).toBe(false);
  await client.capture('bought', {}, AT);
  expect(seen).toEqual([]);
  expect(await client.refreshFlags()).toBe(true);
  expect(seen.map((s) => s.path)).toEqual(['/flags/?v=2']);
  expect(seen[0]!.body).toEqual({ api_key: KEY, distinct_id: 'install-1' });
  // The choice is kept.
  expect((await open(store))!.enabled()).toBe(false);
});

test('flags arrive with JSON payloads, a failed refresh keeps the last good ones, and both are kept', async () => {
  const store = io();
  const client = (await open(store))!;
  expect(client.answered()).toBe(false);
  expect(client.flags()).toEqual({});
  flagsReply = {
    flags: {
      list: { key: 'list', enabled: true, metadata: { payload: '["a","b"]' } },
      plain: { key: 'plain', enabled: true, metadata: { payload: null } },
      off: { key: 'off', enabled: false },
    },
  };
  expect(await client.refreshFlags()).toBe(true);
  const flags = { list: { enabled: true, payload: ['a', 'b'] }, plain: { enabled: true }, off: { enabled: false } };
  expect(client.flags()).toEqual(flags);
  expect(client.answered()).toBe(true);
  status = 500;
  expect(await client.refreshFlags()).toBe(false);
  expect(client.flags()).toEqual(flags);
  // The next launch has them before it asks, offline or not.
  const again = (await open(store))!;
  expect(again.answered()).toBe(true);
  expect(again.flags()).toEqual(flags);
});

test('an answer that is not a flags answer is no answer', () => {
  expect(flagsFromResponse(null)).toBeNull();
  expect(flagsFromResponse({ featureFlags: { paywall: true } })).toBeNull();
  expect(flagsFromResponse({ flags: [] })).toBeNull();
  expect(flagsFromResponse({ flags: { a: { enabled: 'yes' }, b: { enabled: true, metadata: { payload: 'not json' } } } })).toEqual({
    b: { enabled: true, payload: 'not json' },
  });
});
