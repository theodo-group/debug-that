/**
 * Centralized timeout and limit constants.
 *
 * All timing values are in milliseconds unless otherwise noted.
 */

/** Default timeout for CDP/DAP/IPC requests before considering them failed. */
export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Safety net while waiting for a launched runtime to print its inspector URL.
 * The wait already ends when the child exits; this only bounds a child that
 * stays alive without inspecting. Generous because a busy machine starts slowly.
 */
export const INSPECTOR_TIMEOUT_MS = 20_000;

/**
 * How long a connecting inspector socket may stay silent before dbg drops
 * it and opens another. An inspector answers an upgrade within milliseconds.
 * Works around Bun 1.4.0 on macOS (seen 2026-10): under heavy launch/exit
 * churn it now and then leaves a fresh socket without any event from the
 * loop, while a new one opens at once. Remove, with CONNECT_ATTEMPTS and the
 * retry in CdpClient.connect, once a Bun without it is the oldest supported.
 */
export const CONNECT_SILENCE_MS = 1_000;
/** Connect attempts before giving up on an inspector that never answers */
export const CONNECT_ATTEMPTS = 3;

/**
 * How often a launcher reads a child's stderr file while waiting for Node's
 * inspector URL. A pipe would need no polling, but on Bun 1.4.0 (macOS, seen
 * 2026-10) a fresh pipe now and then stays deaf under heavy launch/exit
 * churn; see spawn() in the launcher. Go back to a pipe once that Bun is gone.
 */
export const STDERR_POLL_MS = 10;

/** Time to wait for the daemon socket file to appear after spawning the daemon process. */
export const SPAWN_TIMEOUT_MS = 5_000;

/** Interval between polls when waiting for the daemon socket to appear. */
export const SPAWN_POLL_INTERVAL_MS = 50;

/** Max number of internal bootstrap pauses to skip (Node.js v24+ --inspect-brk). */
export const MAX_INTERNAL_PAUSE_SKIPS = 5;

/** Default timeout for waitForState polling. */
export const STATE_WAIT_TIMEOUT_MS = 5_000;

/** Default timeout for waitUntilStopped (when debugging SHALL pauses). */
export const WAIT_PAUSE_TIMEOUT_MS = 5_000;

/** Default timeout for waitUntilStopped (when debugging MAYBE pauses). */
export const WAIT_MAYBE_PAUSE_TIMEOUT_MS = 500;

/** Max console/exception messages to retain in memory per session. */
export const MAX_BUFFERED_MESSAGES = 1_000;

/** Number of oldest messages to drop at once when the buffer exceeds the limit.
 * Batch dropping avoids O(n) shift on every message. */
export const BUFFER_TRIM_BATCH = 100;

/** Max line width for source code display before horizontal trimming. */
export const MAX_SOURCE_LINE_WIDTH = 120;

/** Time to wait for the DAP "initialized" event during launch/attach. */
export const INITIALIZED_TIMEOUT_MS = 10_000;

/** Max request payload size (bytes) accepted by the daemon IPC server. */
export const MAX_REQUEST_SIZE = 1_048_576; // 1MB

/** Max bytes of adapter stderr to retain for error reporting. */
export const MAX_STDERR_BUFFER = 4_096;
