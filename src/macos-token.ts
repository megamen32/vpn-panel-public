import { randomBytes } from "node:crypto";

/**
 * Capability token for the vpn2-07 rootless macOS client.
 *
 * It lives in the environment, not in source: it is a real credential, and a
 * literal here would travel into every clone, mirror and build context.
 *
 * When it is unset the token falls back to a random value generated at
 * startup. That keeps the panel serving everyone else while making the macOS
 * client fail closed with 401 instead of matching an empty bearer.
 */
const fromEnv = process.env.MACOS_CONFIG_TOKEN;

if (!fromEnv) {
  console.warn(
    "MACOS_CONFIG_TOKEN is not set; the macOS config API will reject every request",
  );
}

export const MACOS_CONFIG_TOKEN = fromEnv || randomBytes(32).toString("hex");
