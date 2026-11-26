/**
 * Packaged builds use these instead of localhost. Caddy (infra/Caddyfile) serves TLS for this
 * host; deploy the server change before releasing a build that points here.
 */
export const PRODUCTION_HTTP = "https://16-192-176-196.sslip.io";
export const PRODUCTION_WS = "wss://16-192-176-196.sslip.io/ws";
