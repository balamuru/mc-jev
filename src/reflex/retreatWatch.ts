export type RetreatStatus = 'ok' | 'failed';

/**
 * Notices a retreat that is not working. Every `windowTicks` it compares the distance to the
 * threat with the distance at the start of the window; if the bot has not gained at least
 * `minGainBlocks`, the retreat has failed (cornered, stuck, or being outrun).
 */
export class RetreatWatch {
  private start: { tick: number; targetId: number; dist: number } | null = null;

  constructor(
    private readonly windowTicks: number,
    private readonly minGainBlocks: number,
  ) {}

  update(tick: number, targetId: number, dist: number): RetreatStatus {
    if (!this.start || this.start.targetId !== targetId) {
      this.start = { tick, targetId, dist };
      return 'ok';
    }
    if (tick - this.start.tick < this.windowTicks) return 'ok';
    const gain = dist - this.start.dist;
    this.start = { tick, targetId, dist };
    return gain < this.minGainBlocks ? 'failed' : 'ok';
  }

  reset(): void {
    this.start = null;
  }
}
