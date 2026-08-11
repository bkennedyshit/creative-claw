// Cross-worker mutual exclusion for test files that drive the real native
// engines (see `test/vitest/vitest.native-engine-paths.mjs` for why).
//
// It has to be a FILESYSTEM lock, not an in-process one. The extensions lane
// runs those files as sibling worker threads of one Vitest process, and each
// worker thread has its own module registry, so a module-scoped mutex is
// invisible to the other workers. A lock file is visible to every worker of
// every pool type (threads, forks, or two lanes racing on the same machine).
//
// Bounded by construction so it can never wedge a run:
//   * every acquire has a hard deadline, after which it takes the lock over and
//     says so instead of hanging;
//   * abandonment is decided by whether the holder PROCESS still exists, so a
//     holder killed by SIGKILL (the run-vitest stall watchdog does exactly that,
//     and a native __fastfail does the same) leaves a lock that the next waiter
//     reclaims immediately instead of blocking forever;
//   * waiting prints a progress line, which keeps the stall watchdog fed and
//     makes "who is holding the engine" visible instead of looking like a hang.
import { openSync, closeSync, writeFileSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** One lock per machine: these tests contend for the same native engine. */
const LOCK_PATH = join(tmpdir(), "openclaw-creative-native-engine.lock");
/** Heartbeat cadence while the lock is held. */
const HEARTBEAT_MS = 5_000;
/**
 * Absolute ceiling on how long a lock file is honoured even if its owner still
 * looks alive. Only a backstop against pid reuse; normal waits end when the
 * holder releases.
 */
const ABANDONED_AFTER_MS = 60 * 60_000;
/** Poll cadence while waiting. */
const POLL_MS = 250;
/** Progress cadence while waiting (also feeds the run-vitest stall watchdog). */
const PROGRESS_MS = 15_000;
/**
 * Hard cap on waiting; past this the waiter takes the lock over and says so.
 *
 * Sized above the worst realistic queue: the video-understanding suite can hold
 * the engine for ~8 minutes of real vision inference and the narration suite for
 * several more, with three short native suites behind them.
 */
const ACQUIRE_DEADLINE_MS = 30 * 60_000;

export interface NativeEngineLockHandle {
  /** Release the lock. Safe to call more than once. */
  release: () => void;
}

interface LockRecord {
  pid: number;
  label: string;
  acquiredAt: string;
}

function log(message: string): void {
  // stdout on purpose: this is the liveness signal the stall watchdog reads.
  // eslint-disable-next-line no-console
  console.log(`[native-engine-lock] ${message}`);
}

function readHolder(): LockRecord | undefined {
  try {
    return JSON.parse(readFileSync(LOCK_PATH, "utf8")) as LockRecord;
  } catch {
    return undefined;
  }
}

function lockAgeMs(): number | undefined {
  try {
    return Date.now() - statSync(LOCK_PATH).birthtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Whether the recorded holder process still exists.
 *
 * This, not the heartbeat, is what decides abandonment. The holder is often
 * blocked in a long SYNCHRONOUS call (ffmpeg demux, a local ASR command, a koffi
 * bridge call), which parks its event loop and stops any timer-based heartbeat
 * even though the work is progressing normally — a heartbeat-age rule handed the
 * lock to a waiter after 60s while the previous holder was still mid-inference,
 * which defeats the whole point. A dead pid, by contrast, is unambiguous: it is
 * exactly the state a watchdog SIGKILL leaves behind.
 */
function holderIsAlive(holder: LockRecord | undefined): boolean {
  if (!holder?.pid) {
    return false;
  }
  try {
    process.kill(holder.pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but is not ours to signal.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function tryCreate(label: string): boolean {
  let fd: number | undefined;
  try {
    // "wx" is the atomic create-or-fail primitive on every platform we run on.
    fd = openSync(LOCK_PATH, "wx");
  } catch {
    return false;
  }
  try {
    const record: LockRecord = { pid: process.pid, label, acquiredAt: new Date().toISOString() };
    writeFileSync(fd, JSON.stringify(record));
    return true;
  } finally {
    closeSync(fd);
  }
}

function forceTakeOver(label: string, why: string): void {
  const holder = readHolder();
  log(
    `taking over the lock for ${label}: ${why} (previous holder pid=${holder?.pid ?? "?"} ` +
      `label=${holder?.label ?? "?"} since=${holder?.acquiredAt ?? "?"})`,
  );
  rmSync(LOCK_PATH, { force: true });
  if (!tryCreate(label)) {
    // Another waiter won the race; that is fine, it also serializes.
    log(`another waiter claimed the lock first; proceeding for ${label} without it`);
  }
}

/**
 * Acquire the native-engine lock for `label`, waiting for any current holder.
 *
 * Never throws and never blocks indefinitely.
 */
export async function acquireNativeEngineLock(label: string): Promise<NativeEngineLockHandle> {
  const startedAt = Date.now();
  let lastProgressAt = startedAt;

  while (!tryCreate(label)) {
    const age = lockAgeMs();
    if (age === undefined) {
      // The lock vanished between the failed create and the stat; retry after a
      // beat rather than spinning on the filesystem.
      await new Promise((resolve) => {
        setTimeout(resolve, POLL_MS);
      });
      continue;
    }
    if (!holderIsAlive(readHolder())) {
      forceTakeOver(label, "the holder process is gone (killed run?)");
      break;
    }
    if (age > ABANDONED_AFTER_MS) {
      forceTakeOver(label, `the lock is ${Math.round(age / 60_000)} minutes old`);
      break;
    }
    const waitedMs = Date.now() - startedAt;
    if (waitedMs > ACQUIRE_DEADLINE_MS) {
      forceTakeOver(label, `waited ${Math.round(waitedMs / 1000)}s, past the acquire deadline`);
      break;
    }
    if (Date.now() - lastProgressAt >= PROGRESS_MS) {
      lastProgressAt = Date.now();
      const holder = readHolder();
      log(
        `${label} waiting ${Math.round(waitedMs / 1000)}s for the native engine ` +
          `(held by pid=${holder?.pid ?? "?"} ${holder?.label ?? "?"})`,
      );
    }
    await new Promise((resolve) => {
      setTimeout(resolve, POLL_MS);
    });
  }

  log(`${label} holds the native engine (waited ${Date.now() - startedAt}ms, pid=${process.pid})`);

  // Observability only: the mtime shows when the holder last had a free event
  // loop. Abandonment is decided by `holderIsAlive`, because a holder blocked in
  // a long synchronous native/ASR call cannot tick a timer.
  const heartbeat = setInterval(() => {
    try {
      const now = new Date();
      utimesSync(LOCK_PATH, now, now);
    } catch {
      // The lock was taken over; nothing useful to do from here.
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  let released = false;
  return {
    release: () => {
      if (released) {
        return;
      }
      released = true;
      clearInterval(heartbeat);
      const holder = readHolder();
      if (holder?.pid === process.pid && holder.label === label) {
        rmSync(LOCK_PATH, { force: true });
      }
      log(`${label} released the native engine after ${Date.now() - startedAt}ms`);
    },
  };
}
