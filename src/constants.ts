/**
 * Centralized timeout and limit constants.
 *
 * All timing values are in milliseconds unless otherwise noted.
 */

/** Default timeout for CDP/DAP/IPC requests before considering them failed. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** Time to wait for the inspector URL to appear on child process stderr after spawn. */
export const INSPECTOR_TIMEOUT_MS = 5_000;

/** Time to wait for the daemon socket file to appear after spawning the daemon process. */
export const SPAWN_TIMEOUT_MS = 5_000;

/** Interval between polls when waiting for the daemon socket to appear. */
export const SPAWN_POLL_INTERVAL_MS = 50;

/** Time to wait for Node.js v24+ to reach the initial --inspect-brk pause state. */
export const BRK_PAUSE_TIMEOUT_MS = 2_000;

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
