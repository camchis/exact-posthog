# @camchis/exact-posthog

PostHog for an [Exact](https://github.com/expo/exact) app's data code: events and feature flags over
PostHog's HTTP API (`/batch/` and `/flags/?v=2`), with no SDK.

**Unofficial and experimental.** This isn't made by Expo or PostHog. It's written for a port of the iOS and
Android app [fiddl](https://fiddl.xyz) to Exact, and Exact is pre-1.0 and changes weekly, so expect breaking
changes. Version 0.1.0.

## Install

Not on npm. Install from GitHub:

```sh
bun add github:camchis/exact-posthog
```

Exact type-checks a package from its declarations only, so this package ships `index.d.ts` and exports it
as `types`.

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
  Offline, the queue waits for the next event and keeps the newest `queueMax` (100).
- **Lifecycle events:** PostHog's names (`Application Installed`, `Opened`, `Became Active`,
  `Backgrounded`). The app decides when to send them.
- **Opt-out:** no events, and the queue is dropped. Flags are still read.
- **Flags:** from `/flags/?v=2`, each as `{ enabled, payload }`, with JSON payloads parsed. The last answer
  is kept across launches, and a failed fetch keeps it. `answered()` says whether PostHog has ever answered
  this install, so an app can fail closed until it has.

## Not yet

- **Device and app properties** (`$os`, `$device_model`, `$app_version`, …): Exact has no source for the OS
  or the model. The version becomes readable with `exactDelivery().version` (expo/exact#360).
- **Uncaught errors:** a data module has no global error hook.
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
