import { describe, expect, it } from 'vitest';
import type { Command } from '../src/control/commands.js';
import {
  GUARD_LEASH_BLOCKS,
  IN_MELEE_BLOCKS,
  GUARD_RETURN_BLOCKS,
  ModeController,
  WANDER_BLOCKS,
  WANDER_RETHINK_MS,
  type DefaultMode,
} from '../src/control/modes.js';
import { IDLE, type Intent } from '../src/intent.js';
import type { Snapshot } from '../src/perception/types.js';
import type { SwarmView } from '../src/swarm/member.js';
import { mob, rules, snap } from './fixtures.js';

const cmd = (name: Command['name']): Command => ({ name, addressed: false });
const at = (x: number, y: number, z: number) => ({ x, y, z });

function setup(defaultMode: DefaultMode = 'guard') {
  const clock = { t: 1_000_000 };
  let rand = 0;
  const modes = new ModeController({
    ownerName: 'Boss',
    defaultMode,
    rules,
    huntRadiusBlocks: 24,
    rng: () => rand,
    now: () => clock.t,
  });
  return {
    modes,
    clock,
    setRand: (r: number) => (rand = r),
    decide: (s: Snapshot, prev: Intent = IDLE) => modes.decide(s, prev),
  };
}

const owner = (id = 90, dist = 10) =>
  mob(id, dist, { category: 'player', kind: 'Boss', approaching: false });
/** A snapshot with the bot standing at `pos`. */
const world = (
  entities = [] as ReturnType<typeof mob>[],
  pos = at(0, 64, 0),
  hp = 20,
): Snapshot => {
  const s = snap(hp, entities);
  return { ...s, self: { ...s.self, position: pos } };
};

describe('ModeController commands', () => {
  it('starts in its default mode', () => {
    expect(setup('guard').modes.mode).toEqual({ name: 'guard' });
    expect(setup('hunt').modes.mode).toEqual({ name: 'hunt' });
    expect(setup('idle').modes.standingDown).toBe(true);
    expect(setup('guard').modes.standingDown).toBe(false);
  });

  it('follows, hunts, stands down and resumes on command, and says what it did', () => {
    const { modes } = setup();
    expect(modes.apply(cmd('follow'), at(0, 0, 0), null)).toBe('following you');
    expect(modes.mode.name).toBe('follow');
    expect(modes.apply(cmd('hunt'), at(0, 0, 0), null)).toMatch(/hunting/);
    expect(modes.mode.name).toBe('hunt');
    expect(modes.apply(cmd('stop'), at(0, 0, 0), null)).toMatch(/standing down/);
    expect(modes.standingDown).toBe(true);
    expect(modes.apply(cmd('auto'), at(0, 0, 0), null)).toMatch(/autonomous \(guard\)/);
    expect(modes.mode).toEqual({ name: 'guard' });
  });

  it('remembers where "guard here" was said, as a copy', () => {
    const { modes } = setup();
    const here = at(10.4, 64, -3.6);
    expect(modes.apply(cmd('guard'), here, null)).toBe('guarding this spot (10, 64, -4)');
    here.x = 999;
    expect(modes.mode).toEqual({ name: 'guard', anchor: at(10.4, 64, -3.6) });
  });

  it('"auto" returns to the configured default, not always to guard', () => {
    const { modes } = setup('hunt');
    modes.apply(cmd('stop'), at(0, 0, 0), null);
    modes.apply(cmd('auto'), at(0, 0, 0), null);
    expect(modes.mode.name).toBe('hunt');
  });

  it('answers help without changing mode', () => {
    const { modes } = setup();
    modes.apply(cmd('follow'), at(0, 0, 0), null);
    expect(modes.apply(cmd('help'), at(0, 0, 0), null)).toContain('guard here');
    expect(modes.mode.name).toBe('follow');
  });

  it('reports its status without changing mode', () => {
    const { modes } = setup();
    modes.apply(cmd('guard'), at(5, 64, 5), null);
    const s = world([mob(1, 4.2), mob(2, 9, { kind: 'skeleton' })], at(5, 64, 5), 17);
    expect(modes.apply(cmd('status'), at(5, 64, 5), s)).toBe(
      'mode guard@5, 64, 5; hp 17/20, food 20; 2 hostiles near, nearest zombie at 4.2m',
    );
    expect(modes.status(world([], at(0, 0, 0)))).toContain('no hostiles near');
    expect(modes.status(null)).toBe('mode guard@5, 64, 5; not in the world');
    expect(modes.mode.name).toBe('guard');
  });
});

describe('ModeController.decide: idle (standing down)', () => {
  it('does nothing even with a zombie at its feet', () => {
    const { modes, decide } = setup();
    modes.apply(cmd('stop'), at(0, 0, 0), null);
    const intent = decide(world([mob(1, 2)]));
    expect(intent.tactic).toBe('idle');
    expect(intent.reason).toBe('standing down');
  });
});

describe('ModeController.decide: default guard (no post)', () => {
  it('fights by the rules and otherwise idles', () => {
    const { decide } = setup();
    expect(decide(world([mob(1, 5)]))).toMatchObject({ tactic: 'engage', targetId: 1 });
    expect(decide(world([]))).toEqual(IDLE);
  });
});

describe('ModeController.decide: guard here', () => {
  const post = at(100, 64, 100);
  function guarding() {
    const s = setup();
    s.modes.apply(cmd('guard'), post, null);
    return s;
  }

  it('fights threats near its post', () => {
    const { decide } = guarding();
    expect(decide(world([mob(1, 5)], at(101, 64, 100)))).toMatchObject({ tactic: 'engage' });
  });

  it('goes back to its post when idle and drifted away', () => {
    const { decide } = guarding();
    const intent = decide(world([], at(100 + GUARD_RETURN_BLOCKS + 1, 64, 100)));
    expect(intent).toMatchObject({
      tactic: 'goto',
      position: post,
      reason: 'returning to my post',
    });
  });

  it('holds its post when close enough', () => {
    const { decide } = guarding();
    expect(decide(world([], at(101, 64, 100))).reason).toBe('holding my post');
  });

  it('stops chasing and returns when the fight has pulled it past the leash', () => {
    const { decide } = guarding();
    const far = at(100 + GUARD_LEASH_BLOCKS + 1, 64, 100);
    const intent = decide(world([mob(1, 5)], far));
    expect(intent).toMatchObject({ tactic: 'goto', position: post });
    expect(intent.reason).toContain('too far from my post');
  });
});

describe('ModeController.decide: follow', () => {
  function following() {
    const s = setup();
    s.modes.apply(cmd('follow'), at(0, 0, 0), null);
    return s;
  }

  it('follows its owner, found by name', () => {
    const { decide } = following();
    expect(decide(world([owner(90)]))).toMatchObject({
      tactic: 'follow',
      targetId: 90,
      reason: 'following Boss',
    });
  });

  it('matches the owner’s name regardless of case, and ignores other players', () => {
    const { decide } = following();
    const other = mob(91, 3, { category: 'player', kind: 'Stranger' });
    const boss = mob(92, 12, { category: 'player', kind: 'BOSS' });
    expect(decide(world([other, boss])).targetId).toBe(92);
    expect(decide(world([other])).reason).toBe('cannot see my owner');
  });

  it('follows an owner who is beyond the perception radius, using the direct lookup', () => {
    const { decide } = following();
    const s: Snapshot = { ...world(), owner: owner(77, 40) };
    expect(decide(s)).toMatchObject({ tactic: 'follow', targetId: 77 });
  });

  it('idles when it cannot see the owner', () => {
    expect(following().decide(world([])).tactic).toBe('idle');
  });

  it('fights threats first, then goes back to following', () => {
    const { decide } = following();
    expect(decide(world([owner(), mob(1, 4)])).tactic).toBe('engage');
    expect(decide(world([owner()])).tactic).toBe('follow');
  });

  it('cannot follow with no owner configured', () => {
    const modes = new ModeController({ defaultMode: 'guard', rules, huntRadiusBlocks: 24 });
    modes.apply(cmd('follow'), at(0, 0, 0), null);
    expect(modes.decide(world([owner()]), IDLE).tactic).toBe('idle');
  });
});

describe('ModeController.decide: hunt', () => {
  function hunting() {
    const s = setup();
    s.modes.apply(cmd('hunt'), at(0, 0, 0), null);
    return s;
  }

  it('engages hostiles farther away than the normal engage radius', () => {
    const { decide, modes } = hunting();
    const far = world([mob(1, 22)]);
    expect(decide(far)).toMatchObject({ tactic: 'engage', targetId: 1 });
    modes.apply(cmd('auto'), at(0, 0, 0), null);
    expect(modes.decide(far, IDLE).tactic).toBe('idle'); // a plain guard ignores it (16 blocks)
  });

  it('wanders to a spot about 15 blocks away when nothing is in sight', () => {
    const { decide, setRand } = hunting();
    setRand(0); // east
    const intent = decide(world([], at(10, 64, 20)));
    expect(intent).toMatchObject({ tactic: 'goto', reason: 'looking for hostiles' });
    expect(intent.position).toEqual({ x: 10 + WANDER_BLOCKS, y: 64, z: 20 });
  });

  it('keeps walking to the same spot until it arrives or the time is up', () => {
    const { decide, setRand, clock } = hunting();
    setRand(0);
    const first = decide(world([], at(0, 64, 0))).position;
    setRand(0.5); // a different direction, if it were to choose again
    expect(decide(world([], at(3, 64, 0))).position).toEqual(first);

    clock.t += WANDER_RETHINK_MS + 1;
    const second = decide(world([], at(3, 64, 0))).position;
    expect(second).not.toEqual(first);
  });

  it('picks a new spot once it arrives', () => {
    const { decide, setRand } = hunting();
    setRand(0);
    const first = decide(world([], at(0, 64, 0))).position!;
    setRand(0.25);
    const next = decide(world([], first)).position;
    expect(next).not.toEqual(first);
  });
});

describe('ModeController in a squad', () => {
  function squadMode(view: Partial<SwarmView> = {}, defaultMode: DefaultMode = 'guard') {
    const swarm: SwarmView = {
      claimedByOthers: () => new Set(),
      focusTarget: () => null,
      helpNeeded: () => null,
      ...view,
    };
    const modes = new ModeController({
      ownerName: 'Boss',
      defaultMode,
      rules,
      huntRadiusBlocks: 24,
      swarm,
      rng: () => 0,
      now: () => 0,
    });
    return { modes, decide: (s: Snapshot, prev: Intent = IDLE) => modes.decide(s, prev) };
  }

  it('fights the squad’s focus target, even when it is not the nearest', () => {
    const { decide } = squadMode({ focusTarget: () => 2 });
    const intent = decide(world([mob(1, 4), mob(2, 9)]));
    expect(intent).toMatchObject({ tactic: 'engage', targetId: 2 });
    expect(intent.reason).toContain('squad focus');
  });

  it('ignores a focus target it cannot see or fight', () => {
    const { decide } = squadMode({ focusTarget: () => 99 });
    expect(decide(world([mob(1, 4)]))).toMatchObject({ targetId: 1 });
    expect(decide(world([mob(2, 9, { visible: false }), mob(1, 4)])).targetId).toBe(1);
  });

  it('moves to an unclaimed threat when the nearest one is taken', () => {
    const { decide } = squadMode({ claimedByOthers: () => new Set([1]) });
    const intent = decide(world([mob(1, 6), mob(2, 9)]));
    expect(intent).toMatchObject({ tactic: 'engage', targetId: 2 });
    expect(intent.reason).toContain('zombie is taken');
  });

  it('stays on a taken target when no other is available, or when already in melee with it', () => {
    const taken = { claimedByOthers: () => new Set([1]) };
    expect(squadMode(taken).decide(world([mob(1, 6)])).targetId).toBe(1);
    expect(squadMode(taken).decide(world([mob(1, IN_MELEE_BLOCKS), mob(2, 9)])).targetId).toBe(1);
  });

  it('picks the nearest of several unclaimed threats', () => {
    const { decide } = squadMode({ claimedByOthers: () => new Set([1]) });
    expect(decide(world([mob(1, 5), mob(3, 12), mob(2, 8)])).targetId).toBe(2);
  });

  it('goes to help a hurt ally when it has nothing to fight', () => {
    const help = { agent: 'Bravo', position: at(30, 64, 5), hp: 4 };
    const { decide } = squadMode({ helpNeeded: () => help });
    expect(decide(world([]))).toMatchObject({
      tactic: 'goto',
      position: help.position,
      reason: 'going to help Bravo',
    });
  });

  it('fights first and helps later', () => {
    const help = { agent: 'Bravo', position: at(30, 64, 5), hp: 4 };
    const { decide } = squadMode({ helpNeeded: () => help });
    expect(decide(world([mob(1, 5)])).tactic).toBe('engage');
  });

  it('does not leave a guard post to help, and does not help while standing down', () => {
    const help = { agent: 'Bravo', position: at(30, 64, 5), hp: 4 };
    const { modes, decide } = squadMode({ helpNeeded: () => help });
    modes.apply(cmd('guard'), at(0, 64, 0), null);
    expect(decide(world([], at(0, 64, 0))).reason).toBe('holding my post');
    modes.apply(cmd('stop'), at(0, 64, 0), null);
    expect(decide(world([])).tactic).toBe('idle');
  });

  it('helps instead of wandering when hunting', () => {
    const help = { agent: 'Bravo', position: at(30, 64, 5), hp: 4 };
    const { modes, decide } = squadMode({ helpNeeded: () => help });
    modes.apply(cmd('hunt'), at(0, 0, 0), null);
    expect(decide(world([])).reason).toBe('going to help Bravo');
  });

  it('behaves exactly like a lone bot when there is no swarm', () => {
    const lone = new ModeController({ defaultMode: 'guard', rules, huntRadiusBlocks: 24 });
    expect(lone.decide(world([mob(1, 6), mob(2, 9)]), IDLE).targetId).toBe(1);
  });
});
