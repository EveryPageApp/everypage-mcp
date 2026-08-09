/**
 * Environment parsing. Everything the server needs is read once, here, so a
 * misconfiguration surfaces at startup with a sentence the user can act on
 * rather than as a 401 buried in the first tool call.
 */

export interface Config {
  apiKey: string;
  baseUrl: string;
  /** Opt-in: register only the read-only tools. Default false. */
  readOnly: boolean;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/** `true`, `1`, `yes` and `on` are all truthy; anything else (incl. unset) is false. */
function envFlag(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  return ["true", "1", "yes", "on"].includes(raw.trim().toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = env.EVERYPAGE_API_KEY?.trim();
  if (!apiKey) {
    throw new ConfigError(
      "EVERYPAGE_API_KEY is not set. Create an API key at https://everypage.co/account " +
        "and pass it to the server, e.g.\n\n" +
        '  "env": { "EVERYPAGE_API_KEY": "ep_live_..." }\n',
    );
  }

  // Accepted token shapes are `ep_live_` (API key, every scope) and `ep_at_`
  // (OAuth access token, narrowed to its grant). A wrong-shaped value is
  // almost always a paste error - say so now rather than after a 401.
  if (!apiKey.startsWith("ep_live_") && !apiKey.startsWith("ep_at_")) {
    throw new ConfigError(
      "EVERYPAGE_API_KEY does not look like an EveryPage token: expected it to start " +
        "with `ep_live_` (an API key from https://everypage.co/account) or `ep_at_` " +
        "(an OAuth access token).",
    );
  }

  const baseUrl = (env.EVERYPAGE_BASE_URL?.trim() || "https://everypage.co").replace(/\/+$/, "");

  return { apiKey, baseUrl, readOnly: envFlag(env.EVERYPAGE_READ_ONLY) };
}
