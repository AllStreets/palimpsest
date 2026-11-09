export interface Event {
  type: string;
  data: unknown;
}

type Listener = (e: Event) => void;

const listeners = new Set<Listener>();

/** Emits an event to every current subscriber, synchronously, in subscription order. */
export function emit(type: string, data: object): void {
  const event: Event = { type, data };
  for (const fn of listeners) {
    fn(event);
  }
}

/** Subscribes to every emitted event. Returns a function that unsubscribes. */
export function subscribe(fn: (e: Event) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
