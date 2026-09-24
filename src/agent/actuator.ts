import { createRequire } from 'node:module';
import type { Bot } from 'mineflayer';
import armorManager from 'mineflayer-armor-manager';
import { loader as autoEat } from 'mineflayer-auto-eat';
import type { Entity } from 'prismarine-entity';
import { isArmorName } from '../reflex/armor.js';
import { attackStyle } from '../reflex/danger.js';
import { isShieldCooldown, shouldBlock } from '../reflex/shield.js';
import { sweepEndangers, weaponSweeps } from '../reflex/sweep.js';
import { isProtectedPlayer } from '../reflex/protect.js';
import { Strafer, pvpAction } from '../reflex/pvp.js';
import type { Vec3Like } from '../perception/types.js';
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
/** How close the bot stays to an entity it is following. */
const FOLLOW_OWNER_RANGE_BLOCKS = 3;
/** Against a player, side-step while within this many blocks. */
const STRAFE_RANGE_BLOCKS = 5;
/** How close counts as having arrived at a `goto` point. */
const ARRIVE_RANGE_BLOCKS = 2;
/** Aim at the target only when it is this close, to save work while chasing. */
const AIM_DISTANCE_BLOCKS = 8;
/** Against a melee mob, side-step while within this many blocks and the weapon recharges. */
const MOB_STRAFE_RANGE_BLOCKS = 3;
/** Inventory slot of the off-hand. */
export const OFFHAND_SLOT = 45;
/** Off-hand items worth equipping as soon as they arrive. */
const OFFHAND_ITEMS = new Set(['shield', 'totem_of_undying']);

export interface ActuatorOptions {
  /** Players never to attack: a last safety net behind the rules. */
  protectedPlayers?: readonly string[];
  /** Hold up a shield between swings and against creepers and archers. */
  shield?: boolean;
  /** Side-step melee mobs while the weapon recharges. */
  strafeMobs?: boolean;
}

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
    if (!item || armorCheckPending) return;
    if (!isArmorName(item.name) && !OFFHAND_ITEMS.has(item.name)) return;
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

type Mode = 'idle' | 'engage' | 'retreat' | 'follow' | 'goto';

/** Drives a real Mineflayer bot: pathfinding, weapon choice, aiming and attack timing. */
export class MineflayerActuator implements Actuator {
  private mode: Mode = 'idle';
  private targetId: number | null = null;
  private ticksSinceAttack = Number.POSITIVE_INFINITY;
  private equipping = false;
  private ticksSinceJump = Number.POSITIVE_INFINITY;
  private ticksWaitingForCrit = 0;
  private readonly strafer = new Strafer();
  private _blocking = false;
  private shieldDisabledTicks = 0;
  private strafing = false;
  private readonly protectedPlayers: readonly string[];

  constructor(
    private readonly bot: Bot,
    private readonly options: ActuatorOptions = {},
  ) {
    this.protectedPlayers = options.protectedPlayers ?? [];
    // An axe hit disables a shield for a while; the server announces it as an item cooldown.
    bot._client?.on(
      'set_cooldown',
      (packet: { cooldownGroup?: unknown; cooldownTicks?: number }) => {
        if (isShieldCooldown(packet.cooldownGroup)) {
          this.shieldDisabledTicks = packet.cooldownTicks ?? 100;
          this.lowerShield();
        }
      },
    );
  }

  /** True while the shield is raised. */
  get blocking(): boolean {
    return this._blocking;
  }

  private isProtected(target: Entity): boolean {
    return (
      target.type === 'player' && isProtectedPlayer(target.username ?? '', this.protectedPlayers)
    );
  }

  engage(targetId: number): void {
    const target = this.bot.entities[targetId];
    if (!target || !this.bot.pathfinder) return;
    if (this.isProtected(target)) {
      this.stop();
      return;
    }
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

  follow(targetId: number): void {
    const target = this.bot.entities[targetId];
    if (!target || !this.bot.pathfinder) return;
    this.mode = 'follow';
    this.targetId = targetId;
    this.bot.pathfinder.setGoal(new goals.GoalFollow(target, FOLLOW_OWNER_RANGE_BLOCKS), true);
  }

  goTo(position: Vec3Like): void {
    if (!this.bot.pathfinder) return;
    this.mode = 'goto';
    this.targetId = null;
    this.bot.pathfinder.setGoal(
      new goals.GoalNear(position.x, position.y, position.z, ARRIVE_RANGE_BLOCKS),
    );
  }

  stop(): void {
    this.lowerShield();
    this.mode = 'idle';
    this.targetId = null;
    this.strafing = false;
    this.strafer.reset();
    this.ticksWaitingForCrit = 0;
    this.bot.pathfinder?.setGoal(null);
    this.bot.clearControlStates();
  }

  setEatingPaused(paused: boolean): void {
    const autoEatPlugin = this.bot.autoEat;
    if (!autoEatPlugin) return;
    if (paused) {
      autoEatPlugin.disableAuto();
      if (autoEatPlugin.isEating) autoEatPlugin.cancelEat();
    } else {
      autoEatPlugin.enableAuto();
    }
  }

  tick(elapsedTicks: number): void {
    this.ticksSinceAttack += elapsedTicks;
    this.shieldDisabledTicks = Math.max(0, this.shieldDisabledTicks - elapsedTicks);
    const target =
      this.mode === 'engage' && this.targetId !== null
        ? this.bot.entities[this.targetId]
        : undefined;
    if (!target?.isValid) {
      this.lowerShield();
      return;
    }
    if (this.isProtected(target)) {
      this.stop();
      return;
    }

    this.equipBestWeapon();

    const dist = this.bot.entity.position.distanceTo(target.position);
    if (dist <= AIM_DISTANCE_BLOCKS) this.aimAt(target);
    this.updateShield(dist);

    const sweepRisk = this.sweepRisk(target);
    if (target.type === 'player' || sweepRisk) {
      // Against a player, or when a ground swing would sweep into another player: jump and hit
      // as a critical (crits don't sweep), and never fall back to a plain ground swing.
      this.fightWithCrits(target, dist, elapsedTicks, sweepRisk);
      return;
    }
    const ready = this.ticksSinceAttack >= this.cooldown();
    this.strafeMob(target, dist, ready, elapsedTicks);
    if (dist <= ATTACK_REACH_BLOCKS && ready) {
      this.lowerShield(); // you cannot swing while blocking
      this.bot.attack(target);
      this.ticksSinceAttack = 0;
    }
  }

  /** True when a ground swing with the held weapon would sweep into a player other than the target. */
  private sweepRisk(target: Entity): boolean {
    if (!weaponSweeps(this.bot.heldItem?.name)) return false;
    const others: Array<{ x: number; y: number; z: number }> = [];
    for (const e of Object.values(this.bot.entities)) {
      if (
        e.type === 'player' &&
        e !== this.bot.entity &&
        e.id !== target.id &&
        e.isValid !== false
      ) {
        others.push(e.position);
      }
    }
    return sweepEndangers(target.position, others);
  }

  /** Raise or lower the shield for this step (see `shouldBlock`). */
  private updateShield(targetDist: number): void {
    if (!this.options.shield) return;
    const me = this.bot.entity.position;
    let melee: number | null = null;
    let creeper: number | null = null;
    let ranged: number | null = null;
    for (const e of Object.values(this.bot.entities)) {
      if (e === this.bot.entity || !e.isValid) continue;
      const hostilePlayer = e.type === 'player' && e.id === this.targetId;
      if (e.type !== 'hostile' && !hostilePlayer) continue;
      const d = me.distanceTo(e.position);
      const style = e.type === 'player' ? 'melee' : attackStyle(e.name ?? '');
      if (style === 'explodes') creeper = creeper === null ? d : Math.min(creeper, d);
      else if (style === 'ranged') ranged = ranged === null ? d : Math.min(ranged, d);
      else melee = melee === null ? d : Math.min(melee, d);
    }
    const want = shouldBlock({
      hasShield: this.bot.inventory.slots[OFFHAND_SLOT]?.name === 'shield',
      disabled: this.shieldDisabledTicks > 0,
      engaging: true,
      targetDist,
      swingReady: this.ticksSinceAttack >= this.cooldown(),
      nearestMeleeDist: melee,
      nearestCreeperDist: creeper,
      nearestRangedDist: ranged,
    });
    if (want) this.raiseShield();
    else this.lowerShield();
  }

  private raiseShield(): void {
    if (this._blocking) return;
    this._blocking = true;
    this.bot.activateItem(true);
  }

  private lowerShield(): void {
    if (!this._blocking) return;
    this._blocking = false;
    this.bot.deactivateItem();
  }

  /** Side-step a melee mob while waiting for the weapon to recharge. */
  private strafeMob(target: Entity, dist: number, ready: boolean, elapsedTicks: number): void {
    const want =
      !!this.options.strafeMobs &&
      !ready &&
      dist <= MOB_STRAFE_RANGE_BLOCKS &&
      attackStyle(target.name ?? '') === 'melee';
    if (want) {
      const side = this.strafer.next(elapsedTicks);
      this.bot.setControlState('left', side === 'left');
      this.bot.setControlState('right', side === 'right');
      this.strafing = true;
    } else if (this.strafing) {
      this.bot.setControlState('left', false);
      this.bot.setControlState('right', false);
      this.strafing = false;
    }
  }

  /**
   * Fighting with critical hits: jump so the hit lands as a critical, don't sprint while in reach
   * (it cancels crits), and, against a player, strafe so they have a harder time hitting back.
   * With `mustCrit`, it never swings from the ground, so the swing cannot sweep into bystanders.
   */
  private fightWithCrits(
    target: Entity,
    dist: number,
    elapsedTicks: number,
    mustCrit: boolean,
  ): void {
    this.ticksSinceJump += elapsedTicks;
    const ready = this.ticksSinceAttack >= this.cooldown();

    if (target.type === 'player' && dist <= STRAFE_RANGE_BLOCKS) {
      const side = this.strafer.next(elapsedTicks);
      this.bot.setControlState('left', side === 'left');
      this.bot.setControlState('right', side === 'right');
    } else {
      this.bot.setControlState('left', false);
      this.bot.setControlState('right', false);
    }

    const action = pvpAction({
      dist,
      onGround: this.bot.entity.onGround,
      velocityY: this.bot.entity.velocity.y,
      ticksSinceAttack: this.ticksSinceAttack,
      cooldownTicks: this.cooldown(),
      ticksSinceJump: this.ticksSinceJump,
      ticksWaitingForCrit: this.ticksWaitingForCrit,
      mustCrit,
    });
    this.bot.setControlState('sprint', action.sprint);
    this.bot.setControlState('jump', action.jump);
    if (action.jump) this.ticksSinceJump = 0;

    if (action.attack) {
      this.lowerShield();
      this.bot.attack(target);
      this.ticksSinceAttack = 0;
      this.ticksWaitingForCrit = 0;
    } else if (ready && dist <= ATTACK_REACH_BLOCKS) {
      this.ticksWaitingForCrit += elapsedTicks;
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
