import { readFileSync, statSync } from "node:fs";

export interface Config {
  url: string;
  user: string;
  token?: string;
  password?: string;
  readonly: boolean;
  allowHttp: boolean;
}

export function loadConfig(): Config {
  const url = process.env.TECHNITIUM_URL;
  if (!url) {
    throw new Error(
      "TECHNITIUM_URL environment variable is required (e.g. https://192.168.1.100:5380)"
    );
  }

  const cleanUrl = url.replace(/\/$/, "");
  const allowHttp = process.env.TECHNITIUM_ALLOW_HTTP === "true";

  // Scheme check is case-insensitive (so HTTP:// can't slip past the guard) and
  // rejects anything that isn't http/https (e.g. file://, ftp://).
  const scheme = cleanUrl.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1].toLowerCase();
  if (scheme !== "http" && scheme !== "https") {
    throw new Error("TECHNITIUM_URL must be an http:// or https:// URL");
  }
  const isHttp = scheme === "http";

  if (isHttp && !allowHttp) {
    throw new Error(
      "TECHNITIUM_URL uses HTTP (insecure). Set TECHNITIUM_ALLOW_HTTP=true to override, or use HTTPS."
    );
  }

  if (isHttp && allowHttp) {
    console.error(
      "[technitium-mcp] WARNING: Using HTTP - credentials transmitted in plaintext"
    );
  }

  // Token priority: env token > token file > password
  let token = process.env.TECHNITIUM_TOKEN;

  if (!token && process.env.TECHNITIUM_TOKEN_FILE) {
    const tokenFile = process.env.TECHNITIUM_TOKEN_FILE;
    try {
      const stat = statSync(tokenFile);
      const mode = stat.mode & 0o777;
      // 0o077 = group+other permission bits; any set means the token file is
      // readable/writable beyond its owner, which is too loose for a secret.
      if (mode & 0o077) {
        const detail = `Token file ${tokenFile} has loose permissions (${mode.toString(8)}). Should be 0600.`;
        if (process.env.TECHNITIUM_STRICT_TOKEN_PERMS === "true") {
          throw new Error(`${detail} (TECHNITIUM_STRICT_TOKEN_PERMS is enabled)`);
        }
        console.error(`[technitium-mcp] WARNING: ${detail}`);
      }
      token = readFileSync(tokenFile, "utf-8").trim();
    } catch (err) {
      throw new Error(`Cannot read token file: ${(err as Error).message}`);
    }
  }

  const password = process.env.TECHNITIUM_PASSWORD;
  const user = process.env.TECHNITIUM_USER || "admin";
  const readonly = process.env.TECHNITIUM_READONLY === "true";

  if (!token && !password) {
    throw new Error(
      "Set TECHNITIUM_TOKEN, TECHNITIUM_TOKEN_FILE, or TECHNITIUM_PASSWORD"
    );
  }

  // Clear sensitive env vars from process
  delete process.env.TECHNITIUM_TOKEN;
  delete process.env.TECHNITIUM_TOKEN_FILE;
  delete process.env.TECHNITIUM_PASSWORD;

  return { url: cleanUrl, user, token, password, readonly, allowHttp };
}
