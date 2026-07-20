import { Cron } from 'croner';
import type { SchedulingDeclaration } from '../contracts';
import type { Logger } from '../logger';

export interface ScheduledTask {
  stop(): void;
}

/**
 * The discovery scheduler seam (DESIGN-045 D-07/D-15) — TWO clocks, split from the downloader
 * every-15-minutes crons. A provider declares its cadence: `event_driven` (YouTube — re-emit on an
 * admin/member edit; an optional slow safety cron) or `cron` (Peloton — nightly scrape + a
 * bearer-freshness SLA). M1 wires the registration seam; the SLA refresh loop lands with Peloton (M3).
 */
export class Scheduler {
  private tasks: ScheduledTask[] = [];

  constructor(private readonly logger: Logger) {}

  register(name: string, scheduling: SchedulingDeclaration, onTick: () => Promise<void>): void {
    if (scheduling.mode === 'event_driven') {
      // Event-driven providers re-emit on API edits; only the optional safety cadence is scheduled.
      if (scheduling.safetyCron) this.cron(name, scheduling.safetyCron, onTick);
      return;
    }
    this.cron(name, scheduling.cron, onTick);
  }

  private cron(name: string, expr: string, onTick: () => Promise<void>): void {
    const job = new Cron(expr, () => {
      void onTick().catch((err: unknown) => {
        this.logger.error({ err, name }, 'scheduled discovery failed');
      });
    });
    this.tasks.push({ stop: () => job.stop() });
  }

  stopAll(): void {
    for (const task of this.tasks) task.stop();
    this.tasks = [];
  }

  get size(): number {
    return this.tasks.length;
  }
}
