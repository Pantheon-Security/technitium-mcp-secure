import type { Config } from "./config.js";
import type { TechnitiumResponse } from "./types.js";
import { audit } from "./audit.js";
import { AuthError, UpstreamError } from "./errors.js";

/** Abort any request to Technitium that hangs longer than this. */
const REQUEST_TIMEOUT_MS = 15_000;

export class TechnitiumClient {
  private sessionToken: string | null = null;
  private config: Config;
  private authInFlight: Promise<void> | null = null;
  // Once the server rejects the static config token, stop reusing it so a
  // password fallback (if any) is taken instead of looping on a dead token.
  private staticTokenRevoked = false;

  constructor(config: Config) {
    this.config = config;
    if (config.token) {
      this.sessionToken = config.token;
    }
  }

  private async authenticate(): Promise<void> {
    if (this.config.token && !this.staticTokenRevoked) {
      this.sessionToken = this.config.token;
      audit.logAuth("token_loaded", true);
      return;
    }

    if (!this.config.password) {
      throw new AuthError("No token or password configured");
    }

    const body = new URLSearchParams({
      user: this.config.user,
      pass: this.config.password,
    });

    const resp = await this.fetchWithTimeout(`${this.config.url}/api/user/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!resp.ok) {
      audit.logAuth("login", false, `HTTP ${resp.status}`);
      throw new UpstreamError(`Login request failed: HTTP ${resp.status}`);
    }

    const data = (await resp.json()) as TechnitiumResponse;

    if (data.status !== "ok" || !data.response) {
      audit.logAuth("login", false, data.errorMessage);
      throw new AuthError("Authentication failed");
    }

    this.sessionToken = data.response.token as string;
    audit.logAuth("login", true);
  }

  /**
   * Handle an invalid-token response. Returns true if a re-auth+retry should be
   * attempted, or throws AuthError when the token is unrecoverable (no password
   * to log in with). Uses compare-and-swap on the token that actually failed so
   * a concurrent call that already refreshed the token isn't clobbered.
   */
  private prepareReauth(failedToken: string | null): void {
    if (!this.config.password) {
      audit.logAuth("token_rejected", false);
      throw new AuthError(
        "Technitium rejected the configured token (invalid or revoked); " +
          "set TECHNITIUM_PASSWORD to enable automatic re-authentication"
      );
    }
    // CAS: only invalidate if the token is still the one that failed — another
    // concurrent call may have already logged in and installed a fresh token.
    if (this.sessionToken === failedToken) {
      if (failedToken === this.config.token) this.staticTokenRevoked = true;
      this.sessionToken = null;
      audit.logAuth("token_expired", false);
    }
  }

  private async ensureAuth(): Promise<void> {
    if (this.sessionToken) return;

    // Mutex: if auth is already in-flight, wait for it
    if (this.authInFlight) {
      await this.authInFlight;
      return;
    }

    this.authInFlight = this.authenticate().finally(() => {
      this.authInFlight = null;
    });
    await this.authInFlight;
  }

  /** fetch() with a hard timeout and upstream errors normalised. */
  private async fetchWithTimeout(
    url: string,
    init: RequestInit
  ): Promise<Response> {
    try {
      return await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const e = err as Error;
      if (e.name === "TimeoutError" || e.name === "AbortError") {
        throw new UpstreamError(
          `Request to Technitium timed out after ${REQUEST_TIMEOUT_MS}ms`
        );
      }
      throw new UpstreamError(`Cannot reach Technitium: ${e.message}`);
    }
  }

  /**
   * Send one token-authenticated request. The token always travels in the
   * POST body (never the query string, which proxies and web servers log).
   */
  private async sendOnce(
    endpoint: string,
    params: Record<string, string>
  ): Promise<Response> {
    const body = new URLSearchParams({
      ...params,
      token: this.sessionToken!,
    });

    return this.fetchWithTimeout(`${this.config.url}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  }

  async call(
    endpoint: string,
    params: Record<string, string> = {}
  ): Promise<TechnitiumResponse> {
    await this.ensureAuth();

    const usedToken = this.sessionToken;
    let resp = await this.sendOnce(endpoint, params);
    let data = await this.readJson(resp);

    if (data.status === "invalid-token") {
      this.prepareReauth(usedToken);
      await this.ensureAuth();
      resp = await this.sendOnce(endpoint, params);
      data = await this.readJson(resp);
    }

    return data;
  }

  /** Parse a JSON API response, mapping transport/parse failures to UpstreamError. */
  private async readJson(resp: Response): Promise<TechnitiumResponse> {
    if (!resp.ok) {
      throw new UpstreamError(`Technitium returned HTTP ${resp.status}`);
    }
    try {
      return (await resp.json()) as TechnitiumResponse;
    } catch {
      throw new UpstreamError("Technitium returned a non-JSON response");
    }
  }

  async callOrThrow(
    endpoint: string,
    params: Record<string, string> = {}
  ): Promise<Record<string, unknown>> {
    const result = await this.call(endpoint, params);

    if (result.status !== "ok") {
      throw new UpstreamError(
        result.errorMessage || `API error: ${result.status}`
      );
    }

    return result.response || {};
  }

  /**
   * Fetch an endpoint whose success body is raw text (e.g. a BIND zone export)
   * but whose error body is a JSON envelope. Re-authenticates once on an
   * expired token and re-validates the retried response.
   */
  async callRawText(
    endpoint: string,
    params: Record<string, string> = {}
  ): Promise<string> {
    await this.ensureAuth();

    const usedToken = this.sessionToken;
    let text = await this.sendRawOnce(endpoint, params);

    if (this.isInvalidTokenText(text)) {
      this.prepareReauth(usedToken);
      await this.ensureAuth();
      text = await this.sendRawOnce(endpoint, params);
    }

    // A JSON envelope here means an error (raw success bodies are not JSON).
    const parsed = this.tryParseEnvelope(text);
    if (parsed && parsed.status !== "ok") {
      throw new UpstreamError(
        parsed.errorMessage || `API error: ${parsed.status}`
      );
    }

    return text;
  }

  private async sendRawOnce(
    endpoint: string,
    params: Record<string, string>
  ): Promise<string> {
    const resp = await this.sendOnce(endpoint, params);
    if (!resp.ok) {
      throw new UpstreamError(
        `Technitium returned HTTP ${resp.status} for ${endpoint}`
      );
    }
    return resp.text();
  }

  private isInvalidTokenText(text: string): boolean {
    const parsed = this.tryParseEnvelope(text);
    return parsed?.status === "invalid-token";
  }

  private tryParseEnvelope(text: string): TechnitiumResponse | null {
    try {
      return JSON.parse(text) as TechnitiumResponse;
    } catch {
      return null;
    }
  }

  clearToken(): void {
    this.sessionToken = null;
  }
}
