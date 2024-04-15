import type { Stream } from ".";

/**
 * Maybe it's a promise. Maybe it's not. Who's to say.
 */
export type MaybePromise<T> = Promise<T> | T;

/**
 * The truthy representation of some type. Will ensure that the type is not null/undefined, and
 * isn't false, or an empty string.
 */
export type Truthy<T> = NonNullable<Exclude<T, false | "">>;

/**
 * Type that may be a callback that resolves to a stream, or just a stream.
 */
export type CallbackOrStream<T, E> = (() => Stream<T, E>) | Stream<T, E>;
