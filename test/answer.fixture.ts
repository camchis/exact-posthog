// Type-checked by types.test.ts, never run: `reportErrors` around a data module's `answer`, with the types an
// Exact app's generated `app.contract.d.ts` declares (a generic `Answer`, `Sources` mapped over each source).
import { openPostHog, reportErrors } from '../index.ts';

type SourceMap = {
  count: { args: [number]; result: { n: number } };
  greet: { args: [string, number]; result: { text: string } };
};
type Source = keyof SourceMap;
type Args<S extends Source> = SourceMap[S]['args'];
type Result<S extends Source> = SourceMap[S]['result'];
interface Store {
  get(name: string): string | null;
}
interface Storage {
  fs: { readFile(path: string): Promise<Uint8Array> };
}
type NativeModule = { call(name: string): Promise<unknown> };
type Sources = { [S in Source]: (args: Args<S>, store: Store, storage: Storage, native?: NativeModule | null) => Result<S> | Promise<Result<S>> };
type Answer = <S extends Source>(source: S, args: Args<S>, store: Store, storage: Storage, native?: NativeModule | null) => Result<S> | Promise<Result<S>>;

declare const sources: Sources;
const client = openPostHog({ key: 'phc_x', host: 'https://eu.i.posthog.com' }, null!);
const timeOf = (args: readonly unknown[]) => (typeof args.at(-1) === 'number' ? (args.at(-1) as number) : undefined);

// Inline, as the README shows it: the report reads the call's arguments, typed.
export const answer: Answer = reportErrors(
  (source, args, store, storage, native) => sources[source](args, store, storage, native),
  async (error, [source, args, , storage]) => {
    const name: Source = source;
    void name, storage.fs;
    await (await client)?.captureException(error, timeOf(args), { handled: false });
  },
);

// One source, wrapped alone.
export const count: Sources['count'] = reportErrors(([n]: Args<'count'>) => ({ n: n + 1 }), (error) => (void error, undefined));
