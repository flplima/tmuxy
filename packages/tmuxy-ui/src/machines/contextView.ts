/**
 * A view of the machine's context through one selector, for an actor the
 * machine invokes. The actor reads `get()` when it acts and hears through
 * `subscribe` when the selected value changes; it never sees the context
 * itself, so a field it does not select can change shape without touching it.
 */

export interface ContextView<T> {
  get(): T;
  /** Called with the new value whenever it differs, by `same`, from the last one. */
  subscribe(listener: (value: T) => void): () => void;
}

interface ObservableContext<C> {
  getSnapshot(): { context: C };
  subscribe(observer: (snapshot: { context: C }) => void): { unsubscribe(): void };
}

export function contextView<C, T>(
  actor: ObservableContext<C>,
  select: (context: C) => T,
  same: (a: T, b: T) => boolean = Object.is,
): ContextView<T> {
  return {
    get: () => select(actor.getSnapshot().context),
    subscribe(listener) {
      let last: T | undefined;
      const subscription = actor.subscribe((snapshot) => {
        const next = select(snapshot.context);
        if (last !== undefined && same(last, next)) return;
        last = next;
        listener(next);
      });
      return () => subscription.unsubscribe();
    },
  };
}
