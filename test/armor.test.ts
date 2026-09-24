import { describe, expect, it } from 'vitest';
import { isArmorName } from '../src/reflex/armor.js';

describe('isArmorName', () => {
  it.each([
    'leather_helmet',
    'iron_chestplate',
    'diamond_leggings',
    'netherite_boots',
    'golden_helmet',
    'chainmail_boots',
    'turtle_helmet',
  ])('%s is armor', (name) => expect(isArmorName(name)).toBe(true));

  it.each(['iron_sword', 'shield', 'elytra', 'iron_helmet_fragment', 'apple', 'boots'])(
    '%s is not armor',
    (name) => expect(isArmorName(name)).toBe(false),
  );
});
