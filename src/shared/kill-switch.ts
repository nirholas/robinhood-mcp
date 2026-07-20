/**
 * The emergency stop.
 *
 * This lives beside the `Executor` rather than inside the risk tool module for
 * one reason: the daemon. `robinhood-mcp-daemon` builds its own `Executor` and
 * loads no tool modules, so a halt installed by a module would leave the one
 * unattended process in the system still placing orders. An operator throwing
 * the switch means stop, everywhere, including in the process they are not
 * looking at.
 *
 * The state is persisted next to the jobs it halts: one file, one lock, and no
 * way for the switch and the job rows to disagree about which database is
 * authoritative.
 */

import type { DatabaseSync } from 'node:sqlite';

const CONTROL_SCHEMA = `
CREATE TABLE IF NOT EXISTS risk_controls (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

const KILL_SWITCH_KEY = 'kill_switch';

export interface KillSwitchState {
  engaged: boolean;
  reason: string | null;
  engagedAt: number | null;
  releasedAt: number | null;
  /** Jobs paused by the engage, so release resumes exactly those. */
  pausedJobIds: string[];
}

export const RELEASED: KillSwitchState = {
  engaged: false,
  reason: null,
  engagedAt: null,
  releasedAt: null,
  pausedJobIds: [],
};

export class KillSwitch {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(CONTROL_SCHEMA);
  }

  /**
   * Current state, read from disk every time.
   *
   * Not cached on purpose. The value of an emergency stop is that it takes
   * effect now, in every process, including one running since before the switch
   * was thrown. A SQLite point read costs microseconds, which is nothing next to
   * the network call it gates.
   */
  read(): KillSwitchState {
    const row = this.db
      .prepare('SELECT value FROM risk_controls WHERE key = ?')
      .get(KILL_SWITCH_KEY) as { value?: unknown } | undefined;

    if (!row || row.value === undefined) return { ...RELEASED };

    try {
      const parsed = JSON.parse(String(row.value)) as Partial<KillSwitchState>;
      return {
        engaged: parsed.engaged === true,
        reason: typeof parsed.reason === 'string' ? parsed.reason : null,
        engagedAt: typeof parsed.engagedAt === 'number' ? parsed.engagedAt : null,
        releasedAt: typeof parsed.releasedAt === 'number' ? parsed.releasedAt : null,
        pausedJobIds: Array.isArray(parsed.pausedJobIds)
          ? parsed.pausedJobIds.map((id) => String(id))
          : [],
      };
    } catch {
      // Fail closed: an unreadable safety control reads as engaged. The
      // alternative is resuming trading because a row got corrupted, which is
      // exactly the failure mode a kill switch exists to prevent.
      return {
        engaged: true,
        reason:
          'The persisted kill-switch row could not be parsed. Treating execution as halted ' +
          'until an operator releases it explicitly.',
        engagedAt: null,
        releasedAt: null,
        pausedJobIds: [],
      };
    }
  }

  write(state: KillSwitchState, now = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO risk_controls (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(KILL_SWITCH_KEY, JSON.stringify(state), now);
  }

  /** The message every blocked order carries, so the cause is never guessed at. */
  blockMessage(state: KillSwitchState): string {
    const when = state.engagedAt ? new Date(state.engagedAt).toISOString() : 'an unrecorded time';
    return (
      `Execution is HALTED by the risk kill switch, engaged at ${when}: ` +
      `${state.reason ?? 'no reason recorded'}. No order can be placed until an operator calls ` +
      'risk_kill_switch_release with confirm=true. Do not attempt to route around this.'
    );
  }
}
