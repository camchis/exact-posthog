# @camchis/exact-posthog

PostHog for an [Exact](https://github.com/expo/exact) app's data code: events, errors and feature flags over
PostHog's HTTP API (`/batch/` and `/flags/?v=2`), with no SDK.

**Unofficial and experimental.** This isn't made by Expo or PostHog. It's written for a port of the iOS and
Android app [fiddl](https://fiddl.xyz) to Exact, and Exact is pre-1.0 and changes weekly, so expect breaking
changes. Version 0.2.0.

## Install

Not on npm. Install from GitHub:

```sh
bun add github:camchis/exact-posthog
```

Exact type-checks a package from its declarations only, so this package ships `index.d.ts` and exports it
as `types` ([expo/exact#518](https://github.com/expo/exact/issues/518)).

## Use

```ts
import { openPostHog } from '@camchis/exact-posthog';

type Events = { screen_viewed: { screen: string }; purchase_started: Record<string, never> };

const client = await openPostHog<Events>(
  { key: 'phc_…', host: 'https://eu.i.posthog.com', lib: 'my-app' },
  {
    fetch: (url, init) => fetch(url, init),
    read: async () => /* the client's file, or undefined before the first write */,
    write: async (text) => /* replace the file */,
    uuid: () => crypto.randomUUID(),
  },
);
// null when the key or host is empty: send nothing.
await client?.capture('screen_viewed', { screen: 'home' }, at);
await client?.refreshFlags();
client?.flags(); // { 'my-flag': { enabled: true, payload: … } }
```

The app passes in everything that touches the host:

- `fetch`;
- the one file the client keeps;
- a UUID source;
- each event's time, since a data module refuses `Date.now()`.

The app also declares the grants in its `app.ts`: `net.fetch <host's origin>`, and `fs.read` and `fs.write`
for the file.

## What it does

- **Install id:** a random id, made on the first launch and kept. It's the only identity sent
  (`distinct_id`), with `$process_person_profile: true`. `installed` says whether this launch made it, so
  the app can send `Application Installed`.
- **Events:** typed by the app's own map. Each event joins a queue that is sent to `/batch/` at once.
  Offline, the queue waits for the next event and keeps the newest `queueMax` (100). Sends that overlap (two
  answers at once) each carry only events no other request is carrying.
- **Lifecycle events:** PostHog's names (`Application Installed`, `Opened`, `Became Active`,
  `Backgrounded`). The app decides when to send them.
- **Opt-out:** no events, and the queue is dropped. Flags are still read.
- **Flags:** from `/flags/?v=2`, each as `{ enabled, payload }`, with JSON payloads parsed. The last answer
  is kept across launches, and a failed fetch keeps it. `answered()` says whether PostHog has ever answered
  this install, so an app can fail closed until it has.

## Errors

PostHog's error tracking reads `$exception` events. The client sends one with `captureException`:

```ts
await client?.captureException(error, at, { handled: false });
```

An Exact data module has no global error hook ([expo/exact#519](https://github.com/expo/exact/issues/519)).
Natively it runs in Hermes with no `onerror`, no `unhandledrejection` and no `reportError`. Exact's prelude
keeps Hermes's rejection tracker for itself, and an unhandled rejection only reaches the runner's log. So the errors that matter are the ones a source lets through:
the runner catches them and fails the resource (`failure(x)` in the Contract). `reportErrors` wraps the
module's `answer`, or one source, and catches them first:

```ts
import { reportErrors } from '@camchis/exact-posthog';

export const answer: Answer = reportErrors(
  (source, args, store, storage, native) => sources[source](args, store, storage, native),
  // The call's arguments come as one list: [source, args, store, storage, native].
  async (error, [, args, , storage]) =>
    (await analytics(storage))?.captureException(error, timeOf(args), { handled: false }),
);
```

`analytics(storage)` and `timeOf(args)` are the app's own: how it opens its client, and where its sources
carry their time.

- **The report happens inside the answer.** The wrapper awaits it and then throws the error on, so the resource
  fails as before. Exact refuses a `fetch` made when no answer is in flight, so a report started after the
  answer ends would wait in the queue until the next event.
- **Timing doesn't change on success.** An answer given at once is still given at once. Only a throw at once
  becomes a rejected promise, which `Answer` and `Sources` accept.
- **Expected failures are skipped.** By default (`isExpectedError`) the wrapper doesn't report Exact's
  `FetchError` (offline, a timeout, a refused request) or a refusal at bake (`code: 'bake'`). Pass your own
  `ignore` as the third argument to change that.
- **Each error goes once.** An error already given to `captureException` and then rethrown isn't reported
  again. Only objects are tracked this way: a thrown string rethrown is reported again, and the repeat limit
  below drops it.

What an `$exception` carries:

- `$exception_list`, with one entry: the error's `type` (its `name`), its `value` (the message),
  `mechanism: { handled, synthetic }`, and a raw stack trace of up to 50 frames.
- **Frames:** `platform: 'custom'` and `lang: 'javascript'`, outermost first, parsed from Hermes, V8 and
  JavaScriptCore stacks.
  - Each file is cut to its last path segment, because a native path names the app's container.
  - Hermes's built-ins, Exact's prelude and engine frames are `in_app: false`.
  - Frames are `resolved: false`: line numbers point into Exact's generated `app.js`, and on the web the
    names are minified.
- **Nothing else.** The stack's message lines are not frames. A thrown string is sent as its message.
  Anything else that isn't an error sends only its kind (`Non-error thrown: object`), since it may hold app
  data.
- **Opt-out applies.** An opted-out install sends no exceptions.
- **Limits:** the same type and message goes at most once a minute (`exceptionRepeatMs`), and at most 100 go
  in one launch (`exceptionMax`).
- **Time:** without `at`, PostHog stamps an exception with the time it receives it.

Uncaught rejections from work no answer awaits (a `void promise`) aren't caught: catch them where they start
and call `captureException`.

## Not yet

- **Device and app properties** (`$os`, `$device_model`, `$app_version`, …): Exact has no source for the OS
  or the model. The version becomes readable with `exactDelivery().version` (expo/exact#360).
- **Errors outside an answer:** rejections no answer awaits, and errors in the view or the native host (see
  [Errors](#errors)). Also missing: chained causes (`error.cause`) and source maps.
- **Also missing:** sessions (`$session_id`), `$feature_flag_called`, `identify`, person and group
  properties, retries with backoff, and gzip.

PostHog answers a headless browser's user agent (HeadlessChrome) with no flags, which is its bot filter. A
web test drive needs a relay that drops the user agent.

## Develop

- `bun install`, then `bun test`. The tests run the client against a loopback PostHog, and check that
  `index.d.ts` matches `index.ts`.
- After changing `index.ts`, run `bun run types`.

## Licence

MIT
