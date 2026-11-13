// PostHog for an Exact app's data code: events, errors and feature flags over PostHog's HTTP API (`/batch/` and
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
  /** The `$exception` events sent at most in one launch (default `EXCEPTION_MAX`). */
  exceptionMax?: number;
  /** The same error (its type and message) is sent at most once in this many ms (default `EXCEPTION_REPEAT_MS`). */
  exceptionRepeatMs?: number;
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
export const EXCEPTION_MAX = 100;
export const EXCEPTION_REPEAT_MS = 60_000;
/** The stack frames sent at most, the innermost kept. */
export const FRAMES_MAX = 50;

/** One stack frame as PostHog's error tracking reads a frame it cannot symbolicate (`platform: 'custom'`). */
export type ExceptionFrame = {
  platform: 'custom';
  lang: 'javascript';
  /** `?` when the stack names none. */
  function: string;
  /** The file's last path segment only: a full path can name the device's app container. */
  filename?: string;
  lineno?: number;
  colno?: number;
  /** False for the engine's own frames (`native`, `<anonymous>`, `[native code]`). */
  in_app: boolean;
  resolved: boolean;
};

/** One entry of `$exception_list`. */
export type Exception = {
  type: string;
  value: string;
  /** `handled`: the app caught it. `synthetic`: what was thrown was not an error, so there is no stack. */
  mechanism: { handled: boolean; synthetic: boolean };
  /** Frames outermost first, the innermost (where it was thrown) last, as PostHog orders them. */
  stacktrace?: { type: 'raw'; frames: ExceptionFrame[] };
};

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
  /**
   * Queues one `$exception` (PostHog's error tracking) for `error` and sends the queue; dropped while opted out.
   * It carries the error's type, message and stack, nothing else. Without `at`, PostHog stamps the time it
   * receives it. `handled` (default true): the app caught it. The same type and message goes at most once
   * per `exceptionRepeatMs`, and at most `exceptionMax` go in one launch.
   */
  captureException(error: unknown, at?: number, options?: { handled?: boolean }): Promise<void>;
  /** Fetches the flags; resolves whether PostHog answered. A failure keeps the last good flags. */
  refreshFlags(): Promise<boolean>;
  /** The flags PostHog last sent, kept across launches. A flag that is off is usually absent. */
  flags(): Record<string, Flag>;
  /** PostHog has answered this install at least once, in this launch or an earlier one. */
  answered(): boolean;
};

type Event = { event: string; properties: Record<string, unknown>; timestamp?: string };

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

// V8 and Hermes: `at fn (file:1:2)`, `at file:1:2`, `at fn (native)`, Hermes's `at fn (address at file:1:2)`.
const AT_FRAME = /^\s*at (?:(.*?) \((.*)\)|(.*))$/;
// JavaScriptCore and SpiderMonkey: `fn@file:1:2`, `@file:1:2`, `fn@[native code]`.
const AT_SIGN_FRAME = /^\s*(.*?)@(.*)$/;
const LOCATION = /^(.*?)(?::(\d+))?(?::(\d+))?$/;
const ENGINE_FILES = new Set(['native', '<anonymous>', '[native code]', 'unknown', '']);
// Files that are not the app's though they have a place: Hermes's built-ins and Exact's data-module prelude.
const RUNTIME_FILES = new Set(['InternalBytecode.js', 'prelude.js']);

function frameAt(fn: string | undefined, where: string): ExceptionFrame {
  const [, file = '', line, column] = LOCATION.exec(where.trim().replace(/^address at /, ''))!;
  const name = fn?.trim() || '?';
  // V8 names an awaited `Promise.all` member's place as `(index 0)`.
  if (ENGINE_FILES.has(file) || /^index \d+$/.test(file)) return { platform: 'custom', lang: 'javascript', function: name, in_app: false, resolved: false };
  // The last path segment only: a native path names the app's container, a web one the server's layout.
  const filename = file.replace(/[?#].*$/, '').split('/').pop() || file;
  return {
    platform: 'custom',
    lang: 'javascript',
    function: name,
    filename,
    ...(line !== undefined ? { lineno: Number(line) } : {}),
    ...(column !== undefined ? { colno: Number(column) } : {}),
    in_app: !RUNTIME_FILES.has(filename),
    resolved: false,
  };
}

/** An error's `stack` as PostHog's frames: outermost first, at most `FRAMES_MAX`, the innermost kept. The
 *  message lines are not frames and are never sent. Lines no engine writes are skipped. */
export function framesFromStack(stack: string): ExceptionFrame[] {
  const lines = stack.split('\n');
  // A stack in the `at` form has its message on top, which may hold an `@`: only `at` lines are frames then.
  const atForm = lines.some((line) => AT_FRAME.test(line));
  const frames: ExceptionFrame[] = [];
  for (const line of lines) {
    if (frames.length === FRAMES_MAX) break;
    const at = atForm ? AT_FRAME.exec(line) : null;
    if (at) frames.push(at[2] !== undefined ? frameAt(at[1], at[2]) : frameAt(undefined, at[3]!));
    const sign = atForm ? null : AT_SIGN_FRAME.exec(line);
    if (sign) frames.push(frameAt(sign[1], sign[2]!));
  }
  return frames.reverse();
}

/** `error` as one `$exception_list` entry: its type, message and stack frames, nothing else. A thrown string
 *  is its own message; anything else that is not an error sends only its kind, since it may hold app data. */
export function exceptionFrom(error: unknown, handled: boolean): Exception {
  try {
    if (typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string') {
      const { name, message, stack } = error as { name?: unknown; message: string; stack?: unknown };
      const frames = typeof stack === 'string' ? framesFromStack(stack) : [];
      return {
        type: typeof name === 'string' && name !== '' ? name : 'Error',
        value: message,
        mechanism: { handled, synthetic: false },
        ...(frames.length > 0 ? { stacktrace: { type: 'raw' as const, frames } } : {}),
      };
    }
  } catch {
    // An error whose fields throw when read: sent as what it is not, below.
  }
  const value = typeof error === 'string' ? error : `Non-error thrown: ${error === null ? 'null' : typeof error}`;
  return { type: 'Error', value, mechanism: { handled, synthetic: true } };
}

/** Errors already given to `captureException` or a `reportErrors` report, so a rethrown one goes once. */
const reported = new WeakSet<object>();
const markReported = (error: unknown) => {
  if (typeof error === 'object' && error !== null) reported.add(error);
};

/** An error that says the device or the build, not a fault in the app: a `fetch` that failed (offline, a
 *  timeout, refused: Exact's `FetchError`) or a refusal at bake (`code: 'bake'`). `reportErrors` skips these. */
export function isExpectedError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { name, code } = error as { name?: unknown; code?: unknown };
  return name === 'FetchError' || code === 'bake';
}

/**
 * `source` (a data module's `answer`, or one source), reporting what it throws: the error goes to `report`
 * with the call's arguments, awaited inside the answer (where Exact lets a `fetch` run), and is then thrown
 * on, so the resource fails as before. An answer given at once is still given at once; a throw at once
 * becomes a rejected promise after the report, which Exact's `Answer` and `Sources` accept. `ignore` (default
 * `isExpectedError`) names errors not to report. A failed report is dropped: the source's error stands.
 */
export function reportErrors<F extends (...args: any[]) => unknown>(
  source: F,
  // The arguments come as one list: a spread of them does not type-check when `F` is Exact's generic `Answer`.
  report: (error: unknown, args: Parameters<F>) => unknown,
  ignore: (error: unknown) => boolean = isExpectedError,
): F {
  async function rethrow(error: unknown, args: Parameters<F>): Promise<never> {
    // Only an object can be told apart when it comes back: a thrown string rethrown is reported again (and
    // `captureException`'s repeat limit drops it).
    let skip = typeof error === 'object' && error !== null && reported.has(error);
    if (!skip) {
      try {
        skip = ignore(error);
      } catch {
        // An `ignore` that throws ignores nothing.
      }
    }
    if (!skip) {
      markReported(error);
      try {
        await report(error, args);
      } catch {
        // The report failing never replaces the error.
      }
    }
    throw error;
  }
  return function (this: unknown, ...args: Parameters<F>) {
    let result: unknown;
    let thenable: boolean;
    try {
      result = source.apply(this, args);
      thenable = typeof (result as { then?: unknown } | null)?.then === 'function';
    } catch (error) {
      return rethrow(error, args);
    }
    return thenable ? Promise.resolve(result).catch((error: unknown) => rethrow(error, args)) : result;
  } as F;
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

  // Events a request is carrying now. Two answers can send at once: each request carries only what no other
  // request is carrying, and a delivered request removes only its own events.
  const inFlight = new Set<Event>();

  /** Sends what is queued and not already on its way; on failure keeps it for the next send. */
  async function deliver() {
    const events = state.queue.filter((e) => !inFlight.has(e));
    if (events.length === 0) return;
    for (const e of events) inFlight.add(e);
    const batch = events.map((e) => ({ ...e, distinct_id: state.installId }));
    try {
      const response = await post('/batch/', { api_key: config.key, batch });
      if (response.ok) state.queue = state.queue.filter((e) => !events.includes(e));
    } catch {
      // Offline: kept, and sent with the next event.
    } finally {
      for (const e of events) inFlight.delete(e);
    }
    await save();
  }

  async function send(event: string, properties: Record<string, unknown>, at: number | undefined) {
    if (state.optedOut) return;
    state.queue.push({
      event,
      // An anonymous install still gets a person profile; nothing identifies who.
      properties: { ...properties, $lib: lib, $process_person_profile: true },
      ...(at !== undefined ? { timestamp: new Date(at).toISOString() } : {}),
    });
    state.queue = state.queue.slice(-queueMax);
    await deliver();
  }

  // This launch's exceptions: how many went, and when each type and message last went (undefined: unstamped).
  const exceptionMax = config.exceptionMax ?? EXCEPTION_MAX;
  const repeatMs = config.exceptionRepeatMs ?? EXCEPTION_REPEAT_MS;
  let exceptionsSent = 0;
  const lastSent = new Map<string, number | undefined>();

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
    captureException: async (error, at, options) => {
      markReported(error);
      if (state.optedOut || exceptionsSent >= exceptionMax) return;
      const exception = exceptionFrom(error, options?.handled ?? true);
      const key = `${exception.type}\n${exception.value}`;
      if (lastSent.has(key)) {
        const last = lastSent.get(key);
        // A repeat with no time to compare is dropped; a stamped one after an unstamped one goes.
        if (at === undefined || (last !== undefined && at - last < repeatMs)) return;
      }
      lastSent.set(key, at);
      exceptionsSent++;
      await send('$exception', { $exception_list: [exception] }, at);
    },
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
