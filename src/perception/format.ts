import type { Snapshot } from './types.js';

/** One-line, human-readable snapshot for logs and debugging. */
export function formatSnapshot(s: Snapshot): string {
  const { position: p } = s.self;
  const pos = `(${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)})`;
  const held = s.self.heldItem ?? 'empty hand';
  const near = s.entities.length
    ? s.entities
        .map(
          (e) =>
            `${e.kind} ${e.dist.toFixed(1)}m ${e.bearing}${e.approaching ? ' approaching' : ''}` +
            (e.held ? ` [${e.held}]` : '') +
            (e.visible ? '' : ' (unseen)'),
        )
        .join(', ')
    : 'nothing nearby';
  return `hp ${s.self.hp} food ${s.self.food} at ${pos} holding ${held} | ${near}`;
}
