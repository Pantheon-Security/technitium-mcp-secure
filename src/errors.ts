/**
 * Typed error hierarchy so the request handler can map failures to the right
 * response shape instead of treating every throw identically.
 */

/** Base for all errors this server raises deliberately. */
export class TechnitiumError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Caller supplied an invalid argument (bad domain, IP, record type, …). */
export class ValidationError extends TechnitiumError {}

/** The Technitium server was unreachable, timed out, or returned an error. */
export class UpstreamError extends TechnitiumError {}

/** Authentication against Technitium failed or no credentials were configured. */
export class AuthError extends TechnitiumError {}
