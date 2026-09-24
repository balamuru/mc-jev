import { createRequire } from 'node:module';
import type { Bot } from 'mineflayer';
import armorManager from 'mineflayer-armor-manager';
import { loader as autoEat } from 'mineflayer-auto-eat';
import type { Entity } from 'prismarine-entity';
import { isArmorName } from '../reflex/armor.js';
import { bestWeapon, cooldownTicks } from '../reflex/weapons.js';
import type { Actuator } from '../reflex/loop.js';

// mineflayer-pathfinder is CommonJS and Node's ESM loader does not expose `goals` as a named
// export, so load it with require while keeping its types.
const pathfinderModule = createRequire(import.meta.url)(
  'mineflayer-pathfinder',
) as typeof import('mineflayer-pathfinder');
const { pathfinder, Movements, goals } = pathfinderModule;

/** How close the bot tries to get to a target it is fighting. */
const FOLLOW_RANGE_BLOCKS = 2;
/** Feet-to-feet distance within which a swing can connect (Java survival reach is about 3). */
export const ATTACK_REACH_BLOCKS = 3.0;
/** Retreating bots try to get this far from the threat. */
const RETREAT_DISTANCE_BLOCKS = 24;
/** Aim at the target only when it is this close, to save work while chasing. */
const AIM_DISTANCE_BLOCKS = 8;

export interface PluginSettings {
  eatBelowFood: number;
}

/** Load pathfinding, armor management and auto-eat. Call once, after the bot has spawned. */
export function attachPlugins(bot: Bot, settings: PluginSettings): void {
  bot.loadPlugin(pathfinder);
  const movements = new Movements(bot);
  movements.canDig = false; // don't tear up the terrain while fighting
  movements.allow1by1towers = false;
  movements.allowSprinting = true;
  bot.pathfinder.setMovements(movements);

  bot.loadPlugin(armorManager);
  void bot.armorManager.equipAll().catch(() => {});
  // The plugin only reacts to items the bot picks up off the ground. Also re-check whenever armor
  // arrives some other way (a chest, crafting, /give), so the bot never fights without it.
  let armorCheckPending = false;
  bot.inventory.on('updateSlot', (_slot, _old, item) => {
    if (!item || !isArmorName(item.name) || armorCheckPending) return;
    armorCheckPending = true;
    setTimeout(() => {
      armorCheckPending = false;
      void bot.armorManager.equipAll().catch(() => {});
    }, 250);
  });

  bot.loadPlugin(autoEat);
  bot.autoEat.setOpts({ minHunger: settings.eatBelowFood });
  bot.autoEat.enableAuto();
}

type Mode = 'idle' | 'engage' | 'retreat';

/** Drives a real Mineflayer bot: pathfinding, weapon choice, aiming and attack timing. */
export class MineflayerActuator implements Actuator {
  private mode: Mode = 'idle';
  private targetId: number | null = null;
  private ticksSinceAttack = Number.POSITIVE_INFINITY;
  private equipping = false;

  constructor(private readonly bot: Bot) {}

  engage(targetId: number): void {
    const target = this.bot.entities[targetId];
    if (!target || !this.bot.pathfinder) return;
    this.mode = 'engage';
    this.targetId = targetId;
    this.ticksSinceAttack = Number.POSITIVE_INFINITY; // strike as soon as in reach
    this.bot.pathfinder.setGoal(new goals.GoalFollow(target, FOLLOW_RANGE_BLOCKS), true);
  }

  retreatFrom(targetId: number): void {
    const threat = this.bot.entities[targetId];
    if (!threat || !this.bot.pathfinder) return;
    this.mode = 'retreat';
    this.targetId = targetId;
    this.bot.pathfinder.setGoal(
      new goals.GoalInvert(new goals.GoalFollow(threat, RETREAT_DISTANCE_BLOCKS)),
      true,
    );
  }

  stop(): void {
    this.mode = 'idle';
    this.targetId = null;
    this.bot.pathfinder?.setGoal(null);
    this.bot.clearControlStates();
  }

  tick(elapsedTicks: number): void {
    this.ticksSinceAttack += elapsedTicks;
    if (this.mode !== 'engage' || this.targetId === null) return;
    const target = this.bot.entities[this.targetId];
    if (!target?.isValid) return;

    this.equipBestWeapon();

    const dist = this.bot.entity.position.distanceTo(target.position);
    if (dist <= AIM_DISTANCE_BLOCKS) this.aimAt(target);
    if (dist <= ATTACK_REACH_BLOCKS && this.ticksSinceAttack >= this.cooldown()) {
      this.bot.attack(target);
      this.ticksSinceAttack = 0;
    }
  }

  private cooldown(): number {
    return cooldownTicks(this.bot.heldItem?.name);
  }

  private aimAt(target: Entity): void {
    void this.bot.lookAt(target.position.offset(0, target.height * 0.85, 0), true).catch(() => {});
  }

  private equipBestWeapon(): void {
    if (this.equipping) return;
    const best = bestWeapon(this.bot.inventory.items());
    if (!best || this.bot.heldItem?.name === best.name) return;
    this.equipping = true;
    void this.bot
      .equip(best, 'hand')
      .catch(() => {})
      .finally(() => {
        this.equipping = false;
      });
  }
}
