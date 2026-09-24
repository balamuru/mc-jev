import type { Intent } from '../intent.js';
import type { Logger } from '../logger.js';
import { formatSnapshot } from '../perception/format.js';
import type { Snapshot } from '../perception/types.js';
import { decideByRules, threatsIn, type RuleSettings } from '../reflex/rules.js';
import type { DecisionEntry, DecisionSink } from '../telemetry/decisionLog.js';
import type { SwarmContext } from '../swarm/member.js';
import type { JevGateway } from './gateway.js';
import { decideWithJev, judgeHostilePlayers, type Thresholds } from './policy.js';
import {
  QUESTION_SET_VERSION,
  buildQuestions,
  playersToJudge,
  buildState,
  parseJudgment,
  type Judgment,
} from './questions.js';

export type StrategicTrigger = 'hurt' | 'newThreat' | 'lowHp';

export interface StrategicSettings {
  intervalMs: number;
  eventTriggers: StrategicTrigger[];
  minGapMs: number;
}

export interface JevSettings {
  model: string;
  timeoutMs: number;
  maxRetries: number;
  thresholds: Thresholds;
}

export interface StrategicDeps {
  agentId: string;
  strategic: StrategicSettings;
  jev: JevSettings;
  rules: RuleSettings;
  gateway: JevGateway;
  currentIntent: () => Intent;
  /** Return false to hold off asking Jev, e.g. while the owner has told the bot to stand down. */
  active?: () => boolean;
  /** Hold `intent` in place of the rules for `ttlMs`. */
  apply: (intent: Intent, ttlMs: number) => void;
  /** Hand control back to the rules straight away. */
  clear: () => void;
  /** The squad this bot belongs to, described to Jev. */
  squad?: () => SwarmContext | null;
  /** Players Jev judged to be about to attack; the caller marks them hostile for a while. */
  onHostilePlayers?: (names: string[], ttlMs: number) => void;
  log: Logger;
  decisions?: DecisionSink;
  now?: () => number;
}

/** An answer is thrown away if HP fell by this much while the request was in flight. */
export const STALE_HP_DROP = 5;
/** How long a player Jev judged hostile stays hostile without further evidence. */
export const HOSTILE_PLAYER_TTL_MS = 10_000;
/** How long Jev's intent is held, as a multiple of the decision interval, before the rules resume. */
export const OVERRIDE_TTL_INTERVALS = 1.5;
/** ...but never shorter than this. */
export const MIN_OVERRIDE_TTL_MS = 1000;

/**
 * The slow layer. It watches snapshots and, every `intervalMs` and on trigger events, asks Jev one
 * batched question set about the situation. The answer is checked for freshness, merged with the
 * rules by `decideWithJev`, and handed to the reflex layer as an override. Whenever Jev is
 * unavailable, slow, unsure or stale, the rules keep deciding; this layer never blocks the bot.
 */
export class StrategicLayer {
  private latest: Snapshot | null = null;
  private lastHp: number | null = null;
  private seenThreats = new Set<number>();
  private lastStartedAt = Number.NEGATIVE_INFINITY;
  private interval: NodeJS.Timeout | null = null;
  private trailing: NodeJS.Timeout | null = null;
  private running = false;
  private readonly reported = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly deps: StrategicDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.interval = setInterval(() => this.request('interval'), this.deps.strategic.intervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.interval) clearInterval(this.interval);
    if (this.trailing) clearTimeout(this.trailing);
    this.interval = null;
    this.trailing = null;
    this.deps.gateway.cancel(this.deps.agentId);
    this.latest = null;
    this.lastHp = null;
    this.seenThreats = new Set();
  }

  /** Forget the situation, e.g. after dying, but keep running. */
  reset(): void {
    if (this.trailing) clearTimeout(this.trailing);
    this.trailing = null;
    this.deps.gateway.cancel(this.deps.agentId);
    this.latest = null;
    this.lastHp = null;
    this.seenThreats = new Set();
  }

  /** Feed the latest snapshot. Detects trigger events and may start a decision. */
  observe(snapshot: Snapshot): void {
    if (!this.running) return;
    const { rules, strategic } = this.deps;
    this.latest = snapshot;
    // While held off (standing down), do not use up trigger events: what is here when the bot
    // resumes should count as new, so Jev is asked straight away.
    if (this.deps.active && !this.deps.active()) return;

    const hp = snapshot.self.hp;
    const ids = new Set(
      [
        ...threatsIn(snapshot, rules),
        ...playersToJudge(snapshot, rules.engageRadiusBlocks, rules),
      ].map((e) => e.id),
    );
    const triggers: StrategicTrigger[] = [];
    if ([...ids].some((id) => !this.seenThreats.has(id))) triggers.push('newThreat');
    if (this.lastHp !== null && hp < this.lastHp - 0.4) triggers.push('hurt');
    if (hp <= rules.retreatHp && (this.lastHp === null || this.lastHp > rules.retreatHp)) {
      triggers.push('lowHp');
    }
    this.seenThreats = ids;
    this.lastHp = hp;

    const fired = triggers.find((t) => strategic.eventTriggers.includes(t));
    if (fired) this.request(`event:${fired}`);
  }

  /** True when there is something to decide about: a threat, or a stranger whose intent Jev can judge. */
  private hasThreats(snapshot: Snapshot | null): snapshot is Snapshot {
    if (snapshot === null) return false;
    const { rules } = this.deps;
    return (
      threatsIn(snapshot, rules).length > 0 ||
      playersToJudge(snapshot, rules.engageRadiusBlocks, rules).length > 0
    );
  }

  private request(trigger: string): void {
    if (!this.running || !(this.deps.active?.() ?? true)) return;
    if (!this.hasThreats(this.latest)) return; // nothing to decide, so no cost
    const gap = this.deps.strategic.minGapMs - (this.now() - this.lastStartedAt);
    if (gap > 0) {
      this.trailing ??= setTimeout(() => {
        this.trailing = null;
        this.request(trigger);
      }, gap);
      return;
    }
    void this.decide(trigger, this.latest);
  }

  private async decide(trigger: string, asked: Snapshot): Promise<void> {
    const { agentId, gateway, jev, rules } = this.deps;
    const squad = this.deps.squad?.() ?? null;
    this.lastStartedAt = this.now();
    const outcome = await gateway.ask(
      agentId,
      {
        model: jev.model,
        state: buildState(asked, rules.engageRadiusBlocks, rules, squad),
        questions: buildQuestions(asked, rules.engageRadiusBlocks, rules, squad),
      },
      { timeoutMs: jev.timeoutMs, maxRetries: jev.maxRetries },
    );
    if (!this.running) return;

    const base = {
      time: new Date(this.now()).toISOString(),
      agent: agentId,
      trigger,
      questionSet: QUESTION_SET_VERSION,
      situation: formatSnapshot(asked),
    };

    if (!outcome.ok) {
      if (outcome.reason === 'superseded') return; // a newer decision replaced this one
      this.reportOnce(outcome.reason, outcome.message);
      this.record({ ...base, outcome: 'error', why: 'no answer from Jev', error: outcome.reason });
      return;
    }

    const { response, latencyMs } = outcome;
    const measured = {
      model: response.model,
      latencyMs,
      costUsd: response.usage.costUsd,
      inputTokens: response.usage.inputTokens,
    };
    const judgment = parseJudgment(response.answers);
    if (!judgment) {
      this.record({ ...base, ...measured, outcome: 'invalid', why: 'unexpected answer shape' });
      return;
    }

    const current = this.latest;
    const staleWhy = this.staleReason(asked, current, judgment);
    if (staleWhy || !this.hasThreats(current)) {
      this.record({
        ...base,
        ...measured,
        answers: summarize(judgment),
        outcome: 'stale',
        why: staleWhy ?? 'the threats are gone',
      });
      return;
    }

    const hostile = judgeHostilePlayers(judgment, current, rules);
    if (hostile.length) this.deps.onHostilePlayers?.(hostile, HOSTILE_PLAYER_TTL_MS);

    const rulesIntent = decideByRules(current, rules, this.deps.currentIntent());
    const decision = decideWithJev(judgment, rulesIntent, current, rules, jev.thresholds);
    if (decision.source === 'jev') {
      const ttl = Math.max(
        MIN_OVERRIDE_TTL_MS,
        this.deps.strategic.intervalMs * OVERRIDE_TTL_INTERVALS,
      );
      this.deps.apply(decision.intent, ttl);
    } else {
      this.deps.clear();
    }
    this.record({
      ...base,
      ...measured,
      answers: summarize(judgment),
      outcome: decision.source === 'jev' ? 'applied' : 'rules',
      why: decision.why,
      ...(hostile.length ? { hostilePlayers: hostile } : {}),
      intent: {
        tactic: decision.intent.tactic,
        targetId: decision.intent.targetId,
        reason: decision.intent.reason,
      },
    });
  }

  /** Why an answer no longer fits the world, or null if it still does. */
  private staleReason(
    asked: Snapshot,
    current: Snapshot | null,
    judgment: Judgment,
  ): string | null {
    if (!current) return 'the bot is no longer in the world';
    if (asked.self.hp - current.self.hp >= STALE_HP_DROP) return 'HP dropped while waiting';
    const target = judgment.target.id;
    if (target !== null && !current.entities.some((e) => e.id === target)) {
      return 'the chosen target is gone';
    }
    return null;
  }

  private record(entry: DecisionEntry): void {
    this.deps.decisions?.write(entry);
  }

  /** Tell the operator once per kind of failure, so a broken key or empty budget does not flood the log. */
  private reportOnce(reason: string, message?: string): void {
    if (this.reported.has(reason)) return;
    this.reported.add(reason);
    this.deps.log.warn(
      `Jev unavailable (${reason}${message ? `: ${message}` : ''}); the rules are deciding. ` +
        'Further occurrences are only written to the decision log.',
    );
  }
}

function summarize(j: Judgment): NonNullable<DecisionEntry['answers']> {
  return {
    tactic: { choice: j.tactic.label, confidence: j.tactic.confidence },
    target: j.target,
    threatLevel: j.threatLevel,
    ambush: j.ambush,
  };
}
