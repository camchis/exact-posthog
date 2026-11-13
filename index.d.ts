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
/** PostHog's `/flags/?v=2` answer as flags, or null for anything else. A payload arrives as JSON text. */
export declare function flagsFromResponse(body: unknown): Record<string, Flag> | null;
/** The client, or null when the config has no key or host (send nothing). */
export declare function openPostHog<Events extends EventMap>(config: PostHogConfig, io: PostHogIO): Promise<PostHog<Events> | null>;
