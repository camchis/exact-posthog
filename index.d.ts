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
    fetch: (url: string, init: {
        method: string;
        headers: Record<string, string>;
        body: string;
    }) => Promise<{
        ok: boolean;
        json(): Promise<unknown>;
    }>;
    /** The client's file, or undefined before the first write. */
    read(): Promise<string | undefined>;
    write(text: string): Promise<void>;
    uuid(): string;
};
/** A flag as PostHog last sent it: whether it is on, and its payload (parsed when it is JSON). */
export type Flag = {
    enabled: boolean;
    payload?: unknown;
};
/** PostHog's app lifecycle events, as its mobile SDKs name them. */
export type Lifecycle = 'Application Installed' | 'Application Opened' | 'Application Became Active' | 'Application Backgrounded';
/** An app's events: each name with the properties it carries. */
export type EventMap = {
    [event: string]: Record<string, unknown>;
};
export declare const QUEUE_MAX = 100;
export declare const DEFAULT_LIB = "exact-posthog";
export declare const EXCEPTION_MAX = 100;
export declare const EXCEPTION_REPEAT_MS = 60000;
/** The stack frames sent at most, the innermost kept. */
export declare const FRAMES_MAX = 50;
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
    mechanism: {
        handled: boolean;
        synthetic: boolean;
    };
    /** Frames outermost first, the innermost (where it was thrown) last, as PostHog orders them. */
    stacktrace?: {
        type: 'raw';
        frames: ExceptionFrame[];
    };
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
    captureException(error: unknown, at?: number, options?: {
        handled?: boolean;
    }): Promise<void>;
    /** Fetches the flags; resolves whether PostHog answered. A failure keeps the last good flags. */
    refreshFlags(): Promise<boolean>;
    /** The flags PostHog last sent, kept across launches. A flag that is off is usually absent. */
    flags(): Record<string, Flag>;
    /** PostHog has answered this install at least once, in this launch or an earlier one. */
    answered(): boolean;
};
/** PostHog's `/flags/?v=2` answer as flags, or null for anything else. A payload arrives as JSON text. */
export declare function flagsFromResponse(body: unknown): Record<string, Flag> | null;
/** An error's `stack` as PostHog's frames: outermost first, at most `FRAMES_MAX`, the innermost kept. The
 *  message lines are not frames and are never sent. Lines no engine writes are skipped. */
export declare function framesFromStack(stack: string): ExceptionFrame[];
/** `error` as one `$exception_list` entry: its type, message and stack frames, nothing else. A thrown string
 *  is its own message; anything else that is not an error sends only its kind, since it may hold app data. */
export declare function exceptionFrom(error: unknown, handled: boolean): Exception;
/** An error that says the device or the build, not a fault in the app: a `fetch` that failed (offline, a
 *  timeout, refused: Exact's `FetchError`) or a refusal at bake (`code: 'bake'`). `reportErrors` skips these. */
export declare function isExpectedError(error: unknown): boolean;
/**
 * `source` (a data module's `answer`, or one source), reporting what it throws: the error goes to `report`
 * with the call's arguments, awaited inside the answer (where Exact lets a `fetch` run), and is then thrown
 * on, so the resource fails as before. An answer given at once is still given at once; a throw at once
 * becomes a rejected promise after the report, which Exact's `Answer` and `Sources` accept. `ignore` (default
 * `isExpectedError`) names errors not to report. A failed report is dropped: the source's error stands.
 */
export declare function reportErrors<F extends (...args: any[]) => unknown>(source: F, report: (error: unknown, args: Parameters<F>) => unknown, ignore?: (error: unknown) => boolean): F;
/** The client, or null when the config has no key or host (send nothing). */
export declare function openPostHog<Events extends EventMap>(config: PostHogConfig, io: PostHogIO): Promise<PostHog<Events> | null>;
