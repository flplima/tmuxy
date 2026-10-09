/**
 * A synchronous fan-out: `emit` calls every subscriber, in subscription
 * order, before it returns. The one listener registry a transport driver
 * needs — its events are a single tagged union, so one hub carries them all.
 */
export class EventHub<A> {
  private readonly listeners = new Set<(event: A) => void>();

  emit(event: A): void {
    for (const listener of this.listeners) listener(event);
  }

  /** Returns the unsubscribe. */
  subscribe(listener: (event: A) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
