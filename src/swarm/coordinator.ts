import { isRole, type Role } from '../control/roles.js';
import type { Logger } from '../logger.js';
import type { JevGateway } from '../strategic/gateway.js';
import type { JevAnswer, JevRequest } from '../strategic/jev.js';
import type { Thresholds } from '../strategic/policy.js';
import type { DecisionSink } from '../telemetry/decisionLog.js';
import type { AllyInfo, Blackboard } from './blackboard.js';
import type { Bus } from './bus.js';

export const COORDINATOR_QUESTION_SET = 'coordinator-v2';
export const COORDINATOR_ID = 'coordinator';
/** At most this many threats are described to Jev. */
export const MAX_COORDINATED_THREATS = 8;
const NO_FOCUS = 'none';

export interface CoordinatorSettings {
  intervalMs: number;
  directiveTtlMs: number;
  model: string;
  timeoutMs: number;
  /** Also assign each bot a role (with Jev, or by gear without it). Off: focus directives only. */
  assignRoles?: boolean;
}

/** The roles the coordinator hands out. Scouting is a configured role only. */
export const ASSIGNABLE_ROLES = ['fighter', 'tank', 'support', 'ranged'] as const;

const ROLE_CRITERIA: Record<(typeof ASSIGNABLE_ROLES)[number], string> = {
  fighter: 'Fighter: fights the threat nearest to itself. The right choice for most bots.',
  tank:
    'Tank: takes on whichever threat is closest to the most hurt squad member, to protect them. ' +
    'Best for a healthy bot with plenty of armor.',
  support:
    'Support: goes to squad members who are hurt and under attack before picking targets of its own.',
  ranged:
    'Ranged: keeps its distance and shoots with a bow, archers and creepers first. Only for a bot ' +
    'with a bow and arrows.',
};

/**
 * Roles without Jev, from gear alone: one bot with a bow and arrows (the least armored of them)
 * becomes `ranged`, the best-armored of the rest becomes `tank`, everyone else is a `fighter`.
 * Ties go first to a bot already in that role (so roles do not flip when, say, a bot picks up a
 * bow mid-fight), then by name.
 */
export function rolesByGear(allies: AllyInfo[]): Record<string, Role> {
  if (allies.length < 2) return {};
  const byName = [...allies].sort((a, b) => a.agent.localeCompare(b.agent));
  const roles: Record<string, Role> = Object.fromEntries(byName.map((a) => [a.agent, 'fighter']));
  const shooter = byName
    .filter((a) => a.canShoot)
    .sort((a, b) => a.armorPoints - b.armorPoints || keeps(b, 'ranged') - keeps(a, 'ranged'))[0];
  if (shooter) roles[shooter.agent] = 'ranged';
  const tank = byName
    .filter((a) => a !== shooter)
    .sort((a, b) => b.armorPoints - a.armorPoints || keeps(b, 'tank') - keeps(a, 'tank'))[0];
  if (tank) roles[tank.agent] = 'tank';
  return roles;
}

export interface CoordinatorDeps {
  gateway: JevGateway;
  board: Blackboard;
  bus: Bus;
  settings: CoordinatorSettings;
  thresholds: Thresholds;
  log: Logger;
  decisions?: DecisionSink;
  now?: () => number;
}

/**
 * The squad's optional commander. It has no body in the game. Every `intervalMs`, when the squad
 * has at least two bots and at least two known threats, it asks Jev which threat the whole
 * squad should focus on and broadcasts a directive that lasts a few seconds. Bots that receive it
 * focus that target; if the coordinator is slow, unsure or down, the directive lapses and every
 * bot simply goes back to choosing for itself.
 */
export class Coordinator {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private warned = false;
  private readonly now: () => number;

  constructor(private readonly deps: CoordinatorDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.deps.settings.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.deps.gateway.cancel(COORDINATOR_ID);
  }

  /** One look at the situation. Exposed for tests; normally driven by the timer. */
  async tick(): Promise<void> {
    if (this.inFlight) return;
    const { board, gateway, settings, thresholds } = this.deps;
    const allies = board.allAllies();
    const threats = board.knownThreats().slice(0, MAX_COORDINATED_THREATS);
    const askFocus = threats.length >= 2;
    const askRoles = !!settings.assignRoles && threats.length >= 1;
    if (allies.length < 2 || (!askFocus && !askRoles)) return; // nothing to coordinate

    const labels: Record<string, string> = { [NO_FOCUS]: 'No single threat should be focused.' };
    for (const t of threats)
      labels[`t${t.id}`] = `${t.kind} at ${Math.round(t.position.x)}, ${Math.round(t.position.z)}`;

    const questions: JevRequest['questions'] = {};
    if (askFocus) {
      questions.focus = {
        type: 'choice',
        instructions:
          'A squad of Minecraft fighters (`squad`) faces the hostile mobs in `threats`. ' +
          'Which one threat should the whole squad focus on first? Prefer the most dangerous, ' +
          'or the one closest to most of the squad, so that they kill it together and quickly.',
        criteria: labels,
      };
    }
    if (askRoles) {
      allies.forEach((a, i) => {
        const offered = ASSIGNABLE_ROLES.filter((r) => r !== 'ranged' || a.canShoot);
        questions[roleQuestionId(i)] = {
          type: 'choice',
          instructions:
            'A squad of Minecraft bots (`squad`) is fighting the hostile mobs in `threats`. ' +
            `Which role should the bot named "${a.agent}" (\`squad[${i}]\`) take for this fight, ` +
            "given the squad's health, armor and weapons? Give the squad a good mix of roles.",
          criteria: Object.fromEntries(offered.map((r) => [r, ROLE_CRITERIA[r]])),
        };
      });
    }

    this.inFlight = true;
    try {
      const outcome = await gateway.ask(
        COORDINATOR_ID,
        {
          model: settings.model,
          state: {
            squad: allies.map((a) => ({
              name: a.agent,
              role: a.role,
              hp: a.hp,
              armor_points: a.armorPoints,
              has_bow_and_arrows: a.canShoot,
              x: Math.round(a.position.x),
              z: Math.round(a.position.z),
            })),
            threats: threats.map((t) => ({
              id: `t${t.id}`,
              kind: t.kind,
              x: Math.round(t.position.x),
              z: Math.round(t.position.z),
              seen_by: t.seenBy.length,
            })),
          },
          questions,
        },
        { timeoutMs: settings.timeoutMs, maxRetries: 0 },
      );

      const base = {
        time: new Date(this.now()).toISOString(),
        agent: COORDINATOR_ID,
        trigger: 'interval',
        questionSet: COORDINATOR_QUESTION_SET,
        situation: `${allies.length} bots, ${threats.length} threats`,
      };
      if (!outcome.ok) {
        if (outcome.reason === 'superseded') return;
        this.reportOnce(outcome.reason, outcome.message);
        let why = 'no answer from Jev';
        if (askRoles) {
          const roles = rolesByGear(allies);
          this.publishRoles(roles);
          why += `; roles by gear: ${describeRoles(roles)}`;
        }
        this.deps.decisions?.write({ ...base, outcome: 'error', why, error: outcome.reason });
        return;
      }

      const measured = {
        model: outcome.response.model,
        latencyMs: outcome.latencyMs,
        costUsd: outcome.response.usage.costUsd,
        inputTokens: outcome.response.usage.inputTokens,
      };
      const answers = outcome.response.answers;
      const parts: string[] = [];
      let stale = false;

      if (askFocus) {
        const focus = readFocus(answers.focus);
        if (focus && focus.targetId !== null && focus.confidence >= thresholds.cautious) {
          if (board.knownThreats().some((t) => t.id === focus.targetId)) {
            this.deps.bus.publish({
              type: 'directive',
              at: this.now(),
              ttlMs: settings.directiveTtlMs,
              focusTargetId: focus.targetId,
            });
            parts.push(`squad focus on t${focus.targetId}`);
          } else {
            stale = true;
          }
        }
      }

      if (askRoles) {
        const roles: Record<string, Role> = {};
        allies.forEach((a, i) => {
          const answer = answers[roleQuestionId(i)];
          if (answer?.type !== 'choice' || !(answer.confidence >= thresholds.cautious)) return;
          const role = answer.choice;
          if (!isRole(role) || (role === 'ranged' && !a.canShoot)) return;
          roles[a.agent] = role;
        });
        if (Object.keys(roles).length) {
          this.publishRoles(roles);
          parts.push(`roles: ${describeRoles(roles)}`);
        }
      }

      if (parts.length) {
        this.deps.decisions?.write({
          ...base,
          ...measured,
          outcome: 'applied',
          why: parts.join('; '),
        });
      } else if (stale) {
        this.deps.decisions?.write({
          ...base,
          ...measured,
          outcome: 'stale',
          why: 'the focus target is gone',
        });
      } else {
        this.deps.decisions?.write({
          ...base,
          ...measured,
          outcome: 'rules',
          why: askRoles ? 'no confident focus or roles' : 'no confident focus',
        });
      }
    } finally {
      this.inFlight = false;
    }
  }

  private publishRoles(roles: Record<string, Role>): void {
    if (!Object.keys(roles).length) return;
    this.deps.bus.publish({
      type: 'roles',
      at: this.now(),
      ttlMs: this.deps.settings.directiveTtlMs,
      roles,
    });
  }

  private reportOnce(reason: string, message?: string): void {
    if (this.warned) return;
    this.warned = true;
    this.deps.log.warn(
      `Coordinator cannot reach Jev (${reason}${message ? `: ${message}` : ''}); bots choose targets on their own` +
        (this.deps.settings.assignRoles ? ', and roles are assigned by gear.' : '.'),
    );
  }
}

const keeps = (a: AllyInfo, role: Role) => (a.role === role ? 1 : 0);

const roleQuestionId = (i: number) => `role_${i}`;

const describeRoles = (roles: Record<string, Role>) =>
  Object.entries(roles)
    .map(([agent, role]) => `${agent} ${role}`)
    .join(', ');

/** The target id Jev picked, or null for "none"; undefined if the answer is unusable. */
function readFocus(
  answer: JevAnswer | undefined,
): { targetId: number | null; confidence: number } | undefined {
  if (answer?.type !== 'choice' || !Number.isFinite(answer.confidence)) return undefined;
  if (answer.choice === NO_FOCUS) return { targetId: null, confidence: answer.confidence };
  const match = /^t(\d+)$/.exec(answer.choice);
  return match ? { targetId: Number(match[1]), confidence: answer.confidence } : undefined;
}
