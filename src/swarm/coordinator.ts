import type { Logger } from '../logger.js';
import type { JevGateway } from '../strategic/gateway.js';
import type { JevAnswer } from '../strategic/jev.js';
import type { Thresholds } from '../strategic/policy.js';
import type { DecisionSink } from '../telemetry/decisionLog.js';
import type { Blackboard } from './blackboard.js';
import type { Bus } from './bus.js';

export const COORDINATOR_QUESTION_SET = 'coordinator-v1';
export const COORDINATOR_ID = 'coordinator';
/** At most this many threats are described to Jev. */
export const MAX_COORDINATED_THREATS = 8;
const NO_FOCUS = 'none';

export interface CoordinatorSettings {
  intervalMs: number;
  directiveTtlMs: number;
  model: string;
  timeoutMs: number;
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
    const { board, gateway, settings, thresholds, bus } = this.deps;
    const allies = board.allAllies();
    const threats = board.knownThreats().slice(0, MAX_COORDINATED_THREATS);
    if (allies.length < 2 || threats.length < 2) return; // nothing to coordinate

    const labels: Record<string, string> = { [NO_FOCUS]: 'No single threat should be focused.' };
    for (const t of threats)
      labels[`t${t.id}`] = `${t.kind} at ${Math.round(t.position.x)}, ${Math.round(t.position.z)}`;

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
          questions: {
            focus: {
              type: 'choice',
              instructions:
                'A squad of Minecraft fighters (`squad`) faces the hostile mobs in `threats`. ' +
                'Which one threat should the whole squad focus on first? Prefer the most dangerous, ' +
                'or the one closest to most of the squad, so that they kill it together and quickly.',
              criteria: labels,
            },
          },
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
        this.deps.decisions?.write({
          ...base,
          outcome: 'error',
          why: 'no answer from Jev',
          error: outcome.reason,
        });
        return;
      }

      const measured = {
        model: outcome.response.model,
        latencyMs: outcome.latencyMs,
        costUsd: outcome.response.usage.costUsd,
        inputTokens: outcome.response.usage.inputTokens,
      };
      const focus = readFocus(outcome.response.answers.focus);
      if (!focus || focus.targetId === null || focus.confidence < thresholds.cautious) {
        this.deps.decisions?.write({
          ...base,
          ...measured,
          outcome: 'rules',
          why: 'no confident focus',
        });
        return;
      }
      if (!board.knownThreats().some((t) => t.id === focus.targetId)) {
        this.deps.decisions?.write({
          ...base,
          ...measured,
          outcome: 'stale',
          why: 'the focus target is gone',
        });
        return;
      }
      bus.publish({
        type: 'directive',
        at: this.now(),
        ttlMs: settings.directiveTtlMs,
        focusTargetId: focus.targetId,
      });
      this.deps.decisions?.write({
        ...base,
        ...measured,
        outcome: 'applied',
        why: `squad focus on t${focus.targetId}`,
      });
    } finally {
      this.inFlight = false;
    }
  }

  private reportOnce(reason: string, message?: string): void {
    if (this.warned) return;
    this.warned = true;
    this.deps.log.warn(
      `Coordinator cannot reach Jev (${reason}${message ? `: ${message}` : ''}); bots choose targets on their own.`,
    );
  }
}

/** The target id Jev picked, or null for "none"; undefined if the answer is unusable. */
function readFocus(
  answer: JevAnswer | undefined,
): { targetId: number | null; confidence: number } | undefined {
  if (answer?.type !== 'choice' || !Number.isFinite(answer.confidence)) return undefined;
  if (answer.choice === NO_FOCUS) return { targetId: null, confidence: answer.confidence };
  const match = /^t(\d+)$/.exec(answer.choice);
  return match ? { targetId: Number(match[1]), confidence: answer.confidence } : undefined;
}
