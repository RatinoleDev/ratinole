/**
 * The one place the brand name and domain live. The owner registered
 * ratinole.trade; the display name (Rationale or Ratinole) is still to be
 * confirmed (HANDOFF section 9). Change it here only.
 */
export const BRAND_NAME = "Ratinole";
export const BRAND_DOMAIN = "ratinole.trade";
export const BRAND_TAGLINE = "Trading agents that show their reasoning, on Robinhood Chain.";
/** The official X account. */
export const X_HANDLE = "RatinoleHQ";
export const X_URL = `https://x.com/${X_HANDLE}`;
/** The official Telegram channel. */
export const TELEGRAM_URL = "https://t.me/ratinole";
/** The public source code: the app, the engine and the vault contracts. */
export const GITHUB_URL = "https://github.com/RatinoleDev/ratinole";
/**
 * The project's token on Robinhood Chain, launched by the owner. The address was given by the owner and read back
 * from the chain before it was put here (symbol RATINOLE, 18 decimals). The app and the vault contracts do not use
 * the token: it is not needed to trade and gives no claim on anything, and the site says so wherever it shows the
 * address. An empty address shows nothing about a token.
 */
export const TOKEN = { ticker: "RATINOLE", address: "0xcEc856b8a7f6946d4E589F400678D9CC43455d58" } as const;
/** Shown on the legal pages. Empty until the owner chooses a public contact address. */
export const CONTACT_EMAIL = "";
