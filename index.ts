// PostHog for an Exact app's data code: events and feature flags over PostHog's HTTP API (`/batch/` and
// `/flags/?v=2`), with no SDK. README.md lists what it does not do yet.
//
// Everything that touches the host comes in as an argument: `fetch`, the one file the client keeps, a UUID
// source, and each event's time (a data module refuses `Date.now()`). So `bun test` can drive the client
// against a loopback PostHog, and the app decides where the file lives and which origin it may fetch.

/** A project key and the ingestion host (e.g. `https://eu.i.posthog.com`). Either empty: no client. */
export type PostHogConfig = {
  key: string;
  host: string;
  /** Sent as `$lib` on every event. */
  lib?: string;
  /** The undelivered events kept at most; the oldest go first. */
  queueMax?: number;
};

export type PostHogIO = {
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
    ok: boolean;
    json(): Promise<unknown>;
  }>;
  /** The client's file, or undefined before the first write. */
  read(): Promise<string | undefined>;
  write(text: string): Promise<void>;
  uuid(): string;
};

/** A flag as PostHog last sent it: whether it is on, and its payload (parsed when it is JSON). */
export type Flag = { enabled: boolean; payload?: unknown };

/** PostHog's app lifecycle events, as its mobile SDKs name them. */
export type Lifecycle = 'Application Installed' | 'Application Opened' | 'Application Became Active' | 'Application Backgrounded';

/** An app's events: each name with the properties it carries. */
export type EventMap = { [event: string]: Record<string, unknown> };

export const QUEUE_MAX = 100;
export const DEFAULT_LIB = 'exact-posthog';

export type PostHog<Events extends EventMap> = {
  /** A random id made on the first launch; the only identity sent. */
  installId(): string;
  /** This launch made the install id (send `Application Installed`). */
  installed: boolean;
  enabled(): boolean;
  /** Opting out drops the queue and stops events; flags are still read. */
  setEnabled(on: boolean): Promise<void>;
  /** Queues one event stamped `at` (ms since the epoch) and sends the queue; dropped while opted out. */
  capture<E extends keyof Events & string>(event: E, properties: Events[E], at: number): Promise<void>;
  lifecycle(event: Lifecycle, at: number): Promise<void>;
  /** Fetches the flags; resolves whether PostHog answered. A failure keeps the last good flags. */
  refreshFlags(): Promise<boolean>;
  /** The flags PostHog last sent, kept across launches. A flag that is off is usually absent. */
  flags(): Record<string, Flag>;
  /** PostHog has answered this install at least once, in this launch or an earlier one. */
  answered(): boolean;
};

type Event = { event: string; properties: Record<string, unknown>; timestamp: string };

type Saved = {
  installId: string;
  optedOut: boolean;
  answered: boolean;
  flags: Record<string, Flag>;
  queue: Event[];
};

/** PostHog's `/flags/?v=2` answer as flags, or null for anything else. A payload arrives as JSON text. */
export function flagsFromResponse(body: unknown): Record<string, Flag> | null {
  if (typeof body !== 'object' || body === null) return null;
  const flags = (body as { flags?: unknown }).flags;
  if (typeof flags !== 'object' || flags === null || Array.isArray(flags)) return null;
  const out: Record<string, Flag> = {};
  for (const [key, value] of Object.entries(flags)) {
    if (typeof value !== 'object' || value === null) continue;
    const { enabled, metadata } = value as { enabled?: unknown; metadata?: { payload?: unknown } };
    if (typeof enabled !== 'boolean') continue;
    let payload = metadata?.payload;
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch {
        // A payload that is not JSON is its text.
      }
    }
    out[key] = payload === undefined || payload === null ? { enabled } : { enabled, payload };
  }
  return out;
}

function parseSaved(text: string | undefined): Partial<Saved> {
  if (!text) return {};
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null ? (value as Partial<Saved>) : {};
  } catch {
    return {};
  }
}

/** The client, or null when the config has no key or host (send nothing). */
export async function openPostHog<Events extends EventMap>(config: PostHogConfig, io: PostHogIO): Promise<PostHog<Events> | null> {
  if (!config.key || !config.host) return null;
  const host = config.host.replace(/\/+$/, '');
  const lib = config.lib ?? DEFAULT_LIB;
  const queueMax = config.queueMax ?? QUEUE_MAX;
  const saved = parseSaved(await io.read());
  const fresh = typeof saved.installId !== 'string' || saved.installId === '';
  const state: Saved = {
    installId: fresh ? io.uuid() : saved.installId!,
    optedOut: saved.optedOut === true,
    answered: saved.answered === true,
    flags: typeof saved.flags === 'object' && saved.flags !== null ? saved.flags : {},
    queue: Array.isArray(saved.queue) ? saved.queue.slice(-queueMax) : [],
  };
  const save = () => io.write(JSON.stringify(state));
  const post = (path: string, body: unknown) =>
    io.fetch(`${host}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  /** Sends what is queued; on failure keeps it for the next send. */
  async function deliver() {
    if (state.queue.length === 0) return;
    const batch = state.queue.map((e) => ({ ...e, distinct_id: state.installId }));
    try {
      const response = await post('/batch/', { api_key: config.key, batch });
      if (response.ok) state.queue = [];
    } catch {
      // Offline: kept, and sent with the next event.
    }
    await save();
  }

  async function send(event: string, properties: Record<string, unknown>, at: number) {
    if (state.optedOut) return;
    state.queue.push({
      event,
      // An anonymous install still gets a person profile; nothing identifies who.
      properties: { ...properties, $lib: lib, $process_person_profile: true },
      timestamp: new Date(at).toISOString(),
    });
    state.queue = state.queue.slice(-queueMax);
    await deliver();
  }

  await save();
  return {
    installId: () => state.installId,
    installed: fresh,
    enabled: () => !state.optedOut,
    setEnabled: async (on) => {
      state.optedOut = !on;
      if (!on) state.queue = [];
      await save();
    },
    capture: (event, properties, at) => send(event, properties, at),
    lifecycle: (event, at) => send(event, {}, at),
    refreshFlags: async () => {
      try {
        const response = await post('/flags/?v=2', { api_key: config.key, distinct_id: state.installId });
        if (!response.ok) return false;
        const flags = flagsFromResponse(await response.json());
        if (!flags) return false;
        state.flags = flags;
        state.answered = true;
        await save();
        return true;
      } catch {
        return false;
      }
    },
    flags: () => state.flags,
    answered: () => state.answered,
  };
}
