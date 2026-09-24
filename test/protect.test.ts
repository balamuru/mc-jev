import { describe, expect, it } from 'vitest';
import { isProtectedPlayer } from '../src/reflex/protect.js';

describe('isProtectedPlayer', () => {
  const protectedNames = ['Boss', 'Friend'];

  it('protects listed players in any case', () => {
    expect(isProtectedPlayer('Boss', protectedNames)).toBe(true);
    expect(isProtectedPlayer('boss', protectedNames)).toBe(true);
    expect(isProtectedPlayer('FRIEND', protectedNames)).toBe(true);
  });

  it('does not protect anyone else, or match partial names', () => {
    expect(isProtectedPlayer('Stranger', protectedNames)).toBe(false);
    expect(isProtectedPlayer('Bossy', protectedNames)).toBe(false);
    expect(isProtectedPlayer('Bos', protectedNames)).toBe(false);
  });

  it('protects nobody when the list is empty or missing', () => {
    expect(isProtectedPlayer('Boss', [])).toBe(false);
    expect(isProtectedPlayer('Boss', undefined)).toBe(false);
  });
});
