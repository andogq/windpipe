import { normalise, type Atom, type MaybeAtom } from "../atom";
import { Stream } from ".";
import { Readable, Writable } from "stream";

/**
 * Marker for the end of a stream.
 */
export const StreamEnd = Symbol.for("STREAM_END");
export type StreamEnd = typeof StreamEnd;

export class StreamBase {
    protected stream: Readable;
    protected stackTrace: string[] = [];
    protected traceComplete: boolean = false;

    constructor(stream: Readable) {
        this.stream = stream;
    }

    /**
     * Add a layer to the trace object. Returns a copy of the current trace.
     */
    protected trace(trace: string) {
        if (!this.traceComplete) {
            this.stackTrace.push(trace);
            this.traceComplete = true;
        }

        return this.getTrace();
    }

    /**
     * Capture the current trace. Creates a clone of the trace to prevent it being modified.
     */
    protected getTrace(): string[] {
        return [...this.stackTrace];
    }

    /**
     * Create a stream from some kind of stream-like value. This can be an iterable, a promise that
     * resolves to some value, or even another readable stream.
     *
     * @group Creation
     */
    static from<T, E>(value: Promise<MaybeAtom<T, E>> | Iterator<MaybeAtom<T, E>> | AsyncIterator<MaybeAtom<T, E>> | Iterable<MaybeAtom<T, E>> | AsyncIterable<MaybeAtom<T, E>> | (() => Promise<MaybeAtom<T, E>>)): Stream<T, E> {
        if (value instanceof Promise) {
            // Likely a promise
            return StreamBase.fromPromise(value);
        }

        if ("next" in value && typeof value.next === "function") {
            // Likely an iterator
            return StreamBase.fromIterator(value);
        }

        if (Symbol.iterator in value || Symbol.asyncIterator in value) {
            // Likely an iterable
            return StreamBase.fromIterable(value);
        }

        if (typeof value === "function") {
            // Likely a `next` function
            return StreamBase.fromNext(value);
        }

        throw new TypeError("expected a promise, (async) iterator, or (async) iterable");
    }

    /**
     * Create a stream from a promise. The promise will be `await`ed, and the resulting value only
     * ever emitted once.
     *
     * @param promise - The promise to create the stream from.
     *
     * @group Creation
     */
    static fromPromise<T, E>(promise: Promise<MaybeAtom<T, E>>): Stream<T, E> {
        let awaited = false;

        return Stream.fromNext(async () => {
            if (!awaited) {
                awaited = true;

                return normalise(await promise);
            } else {
                return StreamEnd;
            }
        });
    }

    /**
     * Create a stream from an iterator.
     *
     * @param iterator - The iterator that will produce values, which may be an async iterator.
     *
     * @group Creation
     */
    static fromIterator<T, E>(iterator: Iterator<MaybeAtom<T, E>> | AsyncIterator<MaybeAtom<T, E>>): Stream<T, E> {
        return Stream.fromNext(async () => {
            const result = iterator.next();
            const { value, done } = result instanceof Promise
                ? (await result)
                : result;

            if (done) {
                return StreamEnd;
            } else {
                return normalise(value);
            }
        });
    }

    /**
     * Create a stream from an iterable.
     *
     * @param iterable - The iterable that will produce an iterator, which may be an async
     * iterator.
     *
     * @group Creation
     */
    static fromIterable<T, E>(iterable: Iterable<MaybeAtom<T, E>> | AsyncIterable<MaybeAtom<T, E>>): Stream<T, E> {
        if (Symbol.iterator in iterable) {
            return StreamBase.fromIterator(iterable[Symbol.iterator]());
        } else {
            return StreamBase.fromIterator(iterable[Symbol.asyncIterator]());
        }
    }

    /**
     * Create a new stream with the provided atom producer.
     *
     * @param next - A callback method to produce the next atom. If no atom is available, then
     * `StreamEnd` must be returned.
     *
     * @group Creation
     */
    static fromNext<T, E>(next: () => Promise<MaybeAtom<T, E> | StreamEnd>): Stream<T, E> {
        return new Stream(new Readable({
            objectMode: true,
            async read() {
                const value = await next();

                if (value === StreamEnd) {
                    this.push(null)
                } else {
                    this.push(normalise(value));
                }
            },
        }));
    }

    /**
     * Create a stream and corresponding writable Node stream, where any writes to the writable
     * Node stream will be emitted on the returned stream.
     */
    static writable<T, E>(): { stream: Stream<T, E>, writable: Writable } {
        type Semaphore<T> = Promise<T> & { resolve: (value: T) => void };
        function semaphore<T>(): Semaphore<T> {
            let resolve: (value: T) => void;

            const promise: Partial<Semaphore<T>> = new Promise((done) => {
                resolve = done;
            });

            promise.resolve = (value) => resolve(value);

            return promise as Semaphore<T>;
        }

        let nextValue = semaphore<Atom<T, E> | StreamEnd>();
        let valueRead = semaphore<void>();

        // The writable stream that will receive the transformed value.
        const writable = new Writable({
            objectMode: true,
            async write(value, _encoding, callback) {
                // Emit the next value
                nextValue.resolve(value);

                // Wait for the value to be emitted before allowing further writes
                await valueRead;

                callback();
            },
            async final(callback) {
                // Emit a `StreamEnd` to close the stream
                nextValue.resolve(StreamEnd);

                // Wait for the read before continuing to close stream
                await valueRead;

                callback();
            }
        });

        return {
            stream: Stream.fromNext(async () => {
                // Get the next value
                const value = await nextValue;

                // Copy semaphore for marking a value as successfully read
                const oldValueRead = valueRead;

                // Reset semaphores for the next usage
                nextValue = semaphore();
                valueRead = semaphore();

                // Mark semaphore for successful read
                oldValueRead.resolve();

                // Emit the actual value
                return value;
            }),
            writable,
        };
    }
}
