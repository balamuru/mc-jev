import { describe, expect, it } from 'vitest';
import {
  RANGED_BACK_OFF_BLOCKS,
  RANGED_RESUME_BLOCKS,
  SUPPORT_REACHED_BLOCKS,
  applyRole,
  isRole,
  type AllyView,
  type Role,
  type RoleInput,
} from '../src/control/roles.js';
import { IDLE, type Intent } from '../src/intent.js';
import type { EntitySummary, Snapshot } from '../src/perception/types.js';
import { mob, snap } from './fixtures.js';

const engage = (targetId: number): Intent => ({ tactic: 'engage', targetId, reason: 'rules' });
/** A mob at (x, z), with the bot at the origin. */
const mobAt = (id: number, x: number, z: number, kind = 'zombie'): EntitySummary =>
  mob(id, Math.round(Math.hypot(x, z) * 10) / 10, { kind, position: { x, y: 64, z } });
const ally = (agent: string, x: number, z: number, hp: number): AllyView => ({
  agent,
  position: { x, y: 64, z },
  hp,
});
const archer = (s: Snapshot, arrows = 16): Snapshot => ({
  ...s,
  inventory: [...s.inventory, 'bowx1', ...(arrows ? [`arrowx${arrows}`] : [])],
});

function input(role: Role, over: Partial<RoleInput> & { entities?: EntitySummary[] }): RoleInput {
  const snapshot = over.snapshot ?? snap(20, over.entities ?? []);
  return {
    role,
    snapshot,
    threats: over.threats ?? snapshot.entities,
    intent: over.intent ?? IDLE,
    previous: over.previous ?? IDLE,
    allies: over.allies ?? [],
    help: over.help ?? null,
  };
}

describe('isRole', () => {
  it('accepts the five roles and nothing else', () => {
    expect(['fighter', 'tank', 'support', 'scout', 'ranged'].every(isRole)).toBe(true);
    expect(isRole('wizard')).toBe(false);
    expect(isRole(null)).toBe(false);
  });
});

describe('fighter and scout', () => {
  it('leave the intent alone', () => {
    const entities = [mobAt(1, 0, -4)];
    for (const role of ['fighter', 'scout'] as const) {
      expect(applyRole(input(role, { entities, intent: engage(1) }))).toEqual(engage(1));
    }
  });
});

describe('tank', () => {
  // Zombie 1 is next to the bot; zombie 2 is on top of a hurt ally 12 blocks away.
  const entities = [mobAt(1, 0, -3), mobAt(2, 12, -1)];

  it('takes the threat closest to the most hurt ally', () => {
    const intent = applyRole(
      input('tank', {
        entities,
        intent: engage(1),
        allies: [ally('B', 12, 0, 6), ally('C', -5, 0, 13)],
      }),
    );
    expect(intent).toMatchObject({ tactic: 'engage', targetId: 2 });
    expect(intent.reason).toContain('covering B');
  });

  it('fights normally when nobody is hurt', () => {
    const intent = applyRole(
      input('tank', { entities, intent: engage(1), allies: [ally('B', 12, 0, 18)] }),
    );
    expect(intent).toEqual(engage(1));
  });

  it('stays on its target unless another is clearly closer to the ally', () => {
    // Zombie 3 is 1 block farther from the ally than zombie 2: not worth switching.
    const near = [mobAt(2, 12, -1), mobAt(3, 12, -2)];
    const intent = applyRole(
      input('tank', {
        entities: near,
        intent: engage(2),
        previous: engage(3),
        allies: [ally('B', 12, 0, 6)],
      }),
    );
    expect(intent.targetId).toBe(3);
  });

  it('leaves non-combat intents alone', () => {
    const intent = applyRole(
      input('tank', { entities, intent: IDLE, allies: [ally('B', 12, 0, 6)] }),
    );
    expect(intent).toEqual(IDLE);
  });
});

describe('support', () => {
  const help = ally('B', 20, 0, 10);

  it('goes to a hurt ally before taking a fresh target of its own', () => {
    const intent = applyRole(
      input('support', { entities: [mobAt(1, 0, -8)], intent: engage(1), help }),
    );
    expect(intent).toMatchObject({ tactic: 'goto', position: help.position });
  });

  it('keeps fighting a target it was already on', () => {
    const intent = applyRole(
      input('support', {
        entities: [mobAt(1, 0, -8)],
        intent: engage(1),
        previous: engage(1),
        help,
      }),
    );
    expect(intent).toEqual(engage(1));
  });

  it('fights a threat right on top of it rather than walking away', () => {
    const intent = applyRole(
      input('support', { entities: [mobAt(1, 0, -2)], intent: engage(1), help }),
    );
    expect(intent).toEqual(engage(1));
  });

  it('fights once it has reached the ally', () => {
    const close = ally('B', SUPPORT_REACHED_BLOCKS - 1, 0, 10);
    const intent = applyRole(
      input('support', { entities: [mobAt(1, 0, -8)], intent: engage(1), help: close }),
    );
    expect(intent).toEqual(engage(1));
  });

  it('fights normally when nobody needs help', () => {
    expect(applyRole(input('support', { entities: [mobAt(1, 0, -8)], intent: engage(1) }))).toEqual(
      engage(1),
    );
  });
});

describe('ranged', () => {
  const withBow = (entities: EntitySummary[], arrows = 16) => archer(snap(20, entities), arrows);

  it('backs away from a melee mob that comes close', () => {
    const snapshot = withBow([mobAt(1, 0, -(RANGED_BACK_OFF_BLOCKS - 1))]);
    const intent = applyRole(input('ranged', { snapshot, intent: engage(1) }));
    expect(intent).toMatchObject({ tactic: 'retreat', targetId: 1 });
  });

  it('backs away from a creeper too', () => {
    const snapshot = withBow([mobAt(1, 0, -5, 'creeper')]);
    expect(applyRole(input('ranged', { snapshot, intent: engage(1) })).tactic).toBe('retreat');
  });

  it('keeps backing away until the mob is well clear (hysteresis)', () => {
    const snapshot = withBow([mobAt(1, 0, -10)]);
    const previous: Intent = { tactic: 'retreat', targetId: 1, reason: 'x' };
    expect(applyRole(input('ranged', { snapshot, intent: engage(1), previous })).tactic).toBe(
      'retreat',
    );
    const clear = withBow([mobAt(1, 0, -(RANGED_RESUME_BLOCKS + 1))]);
    expect(applyRole(input('ranged', { snapshot: clear, intent: engage(1), previous }))).toEqual(
      engage(1),
    );
  });

  it('does not back away from an archer; it shoots it', () => {
    const snapshot = withBow([mobAt(1, 0, -5, 'skeleton')]);
    expect(applyRole(input('ranged', { snapshot, intent: engage(1) }))).toEqual(engage(1));
  });

  it('shoots skeletons and creepers before nearer zombies', () => {
    const snapshot = withBow([mobAt(1, 0, -10), mobAt(2, 0, -15, 'skeleton')]);
    const intent = applyRole(input('ranged', { snapshot, intent: engage(1) }));
    expect(intent).toMatchObject({ tactic: 'engage', targetId: 2 });
    expect(intent.reason).toContain('skeleton first');
  });

  it('fights as a fighter without a bow and arrows', () => {
    const noArrows = withBow([mobAt(1, 0, -5)], 0);
    expect(applyRole(input('ranged', { snapshot: noArrows, intent: engage(1) }))).toEqual(
      engage(1),
    );
    const noBow = snap(20, [mobAt(1, 0, -5)]);
    expect(applyRole(input('ranged', { snapshot: noBow, intent: engage(1) }))).toEqual(engage(1));
  });
});
