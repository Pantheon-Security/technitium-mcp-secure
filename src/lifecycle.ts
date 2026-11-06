import { audit } from "./audit.js";
import { sanitizeError } from "./sanitize.js";

/** The part of the client that shutdown needs. */
export interface LifecycleClient {
  logout(): Promise<void>;
  clearToken(): void;
}

export interface LifecycleOptions {
  /** Defaults to process.exit; tests inject a fake. */
  exit?: (code: number) => void;
  /** Hard cap on the whole shutdown. Defaults to 5000. */
  forceExitMs?: number;
}

/**
 * One exit path for every way the process can end: signals, stdin closing,
 * crashes and startup failures. Each one revokes the session token first, runs
 * at most once, and is bounded by a force-exit timer.
 */
export class Lifecycle {
  private started = false;
  private closeServer: (() => Promise<void>) | null = null;
  private readonly exit: (code: number) => void;
  private readonly forceExitMs: number;

  constructor(
    private readonly client: LifecycleClient,
    opts: LifecycleOptions = {}
  ) {
    this.exit = opts.exit ?? ((code) => process.exit(code));
    this.forceExitMs = opts.forceExitMs ?? 5000;
  }

  setCloseServer(fn: () => Promise<void>): void {
    this.closeServer = fn;
  }

  async shutdown(reason: string, code = 0): Promise<void> {
    if (this.started) return;
    this.started = true;
    audit.logShutdown(reason);
    // Force-exit if anything hangs, so we never wedge on shutdown.
    const timer = setTimeout(() => this.exit(1), this.forceExitMs);
    timer.unref();
    try {
      await this.client.logout();
    } catch {
      // logout is best effort
    }
    this.client.clearToken();
    try {
      await this.closeServer?.();
    } catch {
      // closing the transport must not block the exit
    }
    clearTimeout(timer);
    this.exit(code);
  }

  /** Log a crash through the audit channel (sanitized), then shut down with 1. */
  async fail(event: string, err: unknown): Promise<void> {
    const msg = err instanceof Error ? err.message : String(err);
    audit.logSecurity(event, sanitizeError(msg));
    await this.shutdown(event, 1);
  }
}

export interface ProcessLike {
  on(event: string, listener: (...args: any[]) => void): unknown;
  stdin: { on(event: string, listener: () => void): unknown };
}

/** Wire every exit trigger to the lifecycle. Call this BEFORE logging in. */
export function installProcessHandlers(
  lifecycle: Lifecycle,
  proc: ProcessLike = process
): void {
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    proc.on(sig, () => void lifecycle.shutdown(sig));
  }
  // The gateway ends a session by closing our stdin.
  proc.stdin.on("end", () => void lifecycle.shutdown("stdin_end"));
  proc.stdin.on("close", () => void lifecycle.shutdown("stdin_close"));
  proc.on("uncaughtException", (err: Error) => void lifecycle.fail("uncaught_exception", err));
  proc.on("unhandledRejection", (reason: unknown) => void lifecycle.fail("unhandled_rejection", reason));
}

/**
 * Run startup. If it throws after the session was created, the token is
 * revoked and the process exits 1 instead of leaving a live token behind.
 */
export async function runGuarded(
  lifecycle: Lifecycle,
  start: () => Promise<void>
): Promise<void> {
  try {
    await start();
  } catch (err) {
    await lifecycle.fail("fatal_error", err);
  }
}
