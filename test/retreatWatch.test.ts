import { describe, expect, it } from 'vitest';
import { RetreatWatch } from '../src/reflex/retreatWatch.js';

describe('RetreatWatch', () => {
  it('says ok until a full window has passed', () => {
    const w = new RetreatWatch(40, 1.5);
    expect(w.update(0, 1, 5)).toBe('ok');
    expect(w.update(39, 1, 5)).toBe('ok');
  });

  it('fails when the distance has not grown enough by the end of the window', () => {
    const w = new RetreatWatch(40, 1.5);
    w.update(0, 1, 5);
    expect(w.update(40, 1, 6.4)).toBe('failed');
  });

  it('passes when the distance grew by the minimum or more', () => {
    const w = new RetreatWatch(40, 1.5);
    w.update(0, 1, 5);
    expect(w.update(40, 1, 6.5)).toBe('ok');
  });

  it('fails when the threat is closing in', () => {
    const w = new RetreatWatch(40, 1.5);
    w.update(0, 1, 8);
    expect(w.update(40, 1, 3)).toBe('failed');
  });

  it('starts a fresh window after each check', () => {
    const w = new RetreatWatch(40, 1.5);
    w.update(0, 1, 5);
    expect(w.update(40, 1, 8)).toBe('ok'); // gained 3
    expect(w.update(60, 1, 8)).toBe('ok'); // mid-window
    expect(w.update(80, 1, 8)).toBe('failed'); // gained 0 in the second window
  });

  it('starts over when the threat changes', () => {
    const w = new RetreatWatch(40, 1.5);
    w.update(0, 1, 5);
    expect(w.update(40, 2, 5)).toBe('ok');
    expect(w.update(80, 2, 5)).toBe('failed');
  });

  it('starts over after a reset', () => {
    const w = new RetreatWatch(40, 1.5);
    w.update(0, 1, 5);
    w.reset();
    expect(w.update(40, 1, 5)).toBe('ok');
  });
});
