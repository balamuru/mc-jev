import { describe, expect, it } from 'vitest';
import { formatSnapshot } from '../src/perception/format.js';
import type { Snapshot } from '../src/perception/types.js';

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  t: 0,
  self: {
    position: { x: 10.4, y: 64, z: -3.6 },
    hp: 18,
    food: 20,
    heldItem: 'iron_sword',
    armor: [],
    onGround: true,
    inWater: false,
  },
  entities: [],
  inventory: [],
  ...over,
});

describe('formatSnapshot', () => {
  it('reports an empty surroundings', () => {
    expect(formatSnapshot(snap())).toBe(
      'hp 18 food 20 at (10, 64, -4) holding iron_sword | nothing nearby',
    );
  });

  it('describes nearby entities, approach, held items and unseen ones', () => {
    const line = formatSnapshot(
      snap({
        self: { ...snap().self, heldItem: null },
        entities: [
          {
            id: 1,
            kind: 'zombie',
            category: 'hostile',
            dist: 3.25,
            bearing: 'ahead-left',
            approaching: true,
            held: null,
            visible: true,
          },
          {
            id: 2,
            kind: 'Steve',
            category: 'player',
            dist: 12,
            bearing: 'behind',
            approaching: false,
            held: 'bow',
            visible: false,
          },
        ],
      }),
    );
    expect(line).toContain('holding empty hand');
    expect(line).toContain('zombie 3.3m ahead-left approaching');
    expect(line).toContain('Steve 12.0m behind [bow] (unseen)');
  });
});
