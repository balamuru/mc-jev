import type { SwarmEvent, SwarmEventType } from './events.js';

export type SwarmHandler = (event: SwarmEvent) => void;

/**
 * How bots and the blackboard exchange events. `InProcessBus` is used while everything runs in
 * one process; a NATS-backed implementation could replace it to spread bots across processes,
 * because events are plain JSON.
 */
export interface Bus {
  publish(event: SwarmEvent): void;
  /** Listen to one event type, or `'*'` for all. Returns a function that stops listening. */
  subscribe(type: SwarmEventType | '*', handler: SwarmHandler): () => void;
}

/** A synchronous, in-memory bus. A handler that throws does not stop the others. */
export class InProcessBus implements Bus {
  private readonly handlers = new Map<SwarmEventType | '*', Set<SwarmHandler>>();

  constructor(private readonly onError: (err: unknown) => void = () => {}) {}

  publish(event: SwarmEvent): void {
    for (const key of [event.type, '*'] as const) {
      for (const handler of [...(this.handlers.get(key) ?? [])]) {
        try {
          handler(event);
        } catch (err) {
          this.onError(err);
        }
      }
    }
  }

  subscribe(type: SwarmEventType | '*', handler: SwarmHandler): () => void {
    const set = this.handlers.get(type) ?? new Set<SwarmHandler>();
    set.add(handler);
    this.handlers.set(type, set);
    return () => void set.delete(handler);
  }
}
