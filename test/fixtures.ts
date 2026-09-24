import type { EntitySummary, Snapshot } from '../src/perception/types.js';
import type { RuleSettings } from '../src/reflex/rules.js';

/**
 * Rule settings for tests, spelled out so they do not depend on config/default.json.
 * Retreating is switched on here (the shipped default is off) because most tests exercise it.
 */
export const rules: RuleSettings = {
  pvp: true,
  protectedPlayers: [],
  retreat: true,
  retreatHp: 6,
  resumeHp: 14,
  engageRadiusBlocks: 16,
  eatBelowFood: 15,
  noEatRadiusBlocks: 10,
  dangerMargin: 0.8,
  retreatCheckMs: 2000,
  retreatMinGainBlocks: 1.5,
  fightBackMs: 4000,
};

export const IRON_ARMOR = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'];

export interface GearOptions {
  armor?: string[];
  weapon?: string | null;
}

export const mob = (
  id: number,
  dist: number,
  over: Partial<EntitySummary> = {},
): EntitySummary => ({
  id,
  kind: 'zombie',
  category: 'hostile',
  dist,
  bearing: 'ahead',
  approaching: true,
  held: null,
  visible: true,
  ...over,
});

/** A snapshot with the bot at `hp`, wearing full iron armor and holding an iron sword by default. */
export function snap(hp: number, entities: EntitySummary[], gear: GearOptions = {}): Snapshot {
  const armor = gear.armor ?? IRON_ARMOR;
  const weapon = gear.weapon === undefined ? 'iron_sword' : gear.weapon;
  return {
    t: 0,
    self: {
      position: { x: 0, y: 64, z: 0 },
      hp,
      food: 20,
      heldItem: weapon,
      armor,
      onGround: true,
      inWater: false,
    },
    entities: [...entities].sort((a, b) => a.dist - b.dist),
    inventory: weapon ? [`${weapon}x1`] : [],
  };
}

/** No armor and no weapon: any fight is costly, so the rules retreat at low HP. */
export const BARE: GearOptions = { armor: [], weapon: null };
