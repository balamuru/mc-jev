import { describe, expect, it } from 'vitest';
import { ProvocationTracker } from '../src/perception/provocation.js';

const drop = (amount = 3, mobNearby = false) => ({ amount, mobNearby });

describe('ProvocationTracker', () => {
  it('marks a player who swung within reach just before the bot lost HP', () => {
    const t = new ProvocationTracker();
    t.noteSwing('Rival', 2.5, 1000);
    expect(t.noteHpDrop(drop(), 1200)).toEqual(['rival']);
    expect(t.hostileNames(1300)).toEqual(new Set(['rival']));
  });

  it('ignores swings that were too early or too far away', () => {
    const t = new ProvocationTracker();
    t.noteSwing('Early', 2, 1000);
    t.noteSwing('Far', 9, 1900);
    expect(t.noteHpDrop(drop(), 2000)).toEqual([]);
    expect(t.hostileNames(2000).size).toBe(0);
  });

  it('marks nobody when a mob is right next to the bot', () => {
    const t = new ProvocationTracker();
    t.noteSwing('Bystander', 3, 1000);
    expect(t.noteHpDrop(drop(3, true), 1100)).toEqual([]);
    expect(t.hostileNames(1100).size).toBe(0);
  });

  it('ignores tiny HP changes', () => {
    const t = new ProvocationTracker();
    t.noteSwing('Rival', 2, 1000);
    expect(t.noteHpDrop(drop(0.2), 1100)).toEqual([]);
  });

  it('marks every player who swung inside the window', () => {
    const t = new ProvocationTracker();
    t.noteSwing('A', 2, 1000);
    t.noteSwing('B', 4, 1100);
    expect(t.noteHpDrop(drop(), 1200).sort()).toEqual(['a', 'b']);
  });

  it('trusts an explicit hit from the server', () => {
    const t = new ProvocationTracker();
    t.noteHit('Rival', 5000);
    expect(t.hostileNames(5001)).toEqual(new Set(['rival']));
  });

  it('forgets an attacker after the memory time, and refreshes it on a new hit', () => {
    const t = new ProvocationTracker({
      swingWindowMs: 600,
      reachBlocks: 6.5,
      memoryMs: 10_000,
      minDrop: 0.4,
    });
    t.noteHit('Rival', 0);
    expect(t.hostileNames(9_999).has('rival')).toBe(true);
    expect(t.hostileNames(10_001).has('rival')).toBe(false);
    t.noteHit('Rival', 20_000);
    expect(t.hostileNames(29_000).has('rival')).toBe(true);
  });

  it('marks a player hostile for a set time when Jev says so, and never shortens an existing mark', () => {
    const t = new ProvocationTracker();
    t.markHostile('Shady', 0, 5000);
    expect(t.hostileNames(4999).has('shady')).toBe(true);
    expect(t.hostileNames(5001).has('shady')).toBe(false);
    t.noteHit('Rival', 0);
    t.markHostile('Rival', 0, 100); // shorter than the hit's memory
    expect(t.hostileNames(15_000).has('rival')).toBe(true);
  });

  it('matches names regardless of case', () => {
    const t = new ProvocationTracker();
    t.noteHit('RiVaL', 0);
    expect(t.hostileNames(1)).toEqual(new Set(['rival']));
  });

  it('forgets everything on reset', () => {
    const t = new ProvocationTracker();
    t.noteHit('Rival', 0);
    t.noteSwing('Other', 1, 0);
    t.reset();
    expect(t.hostileNames(1).size).toBe(0);
    expect(t.noteHpDrop(drop(), 100)).toEqual([]);
  });
});
