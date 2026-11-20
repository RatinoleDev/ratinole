import { expect, test, type Page, type Route } from "@playwright/test";

const ROUTES = ["/", "/app", "/app/studio", "/app/agents", "/app/leaderboard", "/app/vault", "/app/payroll", "/app/settings", "/terms", "/privacy", "/risk"];

const me = { address: "0x7a3f00000000000000000000000000000000091c2", maxSizePct: 35, dailyLossCapPct: 3, agentCount: 1, maxAgents: 3 };

const plan = {
  markets: ["ETH"],
  kind: "entry_exit",
  entry: [{ signal: "rsi", op: "<", value: 30 }],
  exit: { takeProfitPct: 8, stopLossPct: 4 },
  filters: [],
  sizePctOfCash: 25,
};

const agent = {
  id: "ag1",
  name: "Meridian",
  market: "ETH",
  marketLabel: "ETH / USDG",
  mode: "paper",
  status: "active",
  sentence: "Buy ETH when RSI drops below 30",
  plan,
  rows: [{ label: "Market", lines: ["ETH / USDG"] }],
  paramsText: ["Buys only when confidence is at least 50%, chosen on the tuning days."],
  backtestId: "bt1",
  launchedAt: "2026-11-19T09:56:00.000Z",
  startingCash: 10000,
  equity: null,
  returnPct: null,
  holdingPct: null,
  inPosition: false,
  decisions: 0,
  lastDecisionAt: null,
};

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/** Mock the API. `signedIn` decides what /api/me returns; `extra` overrides handlers by "METHOD /path". */
async function mockApi(page: Page, opts: { signedIn: boolean; extra?: Record<string, (route: Route) => unknown> }) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const key = `${route.request().method()} ${url.pathname.replace(/^\/api/, "")}`;
    const custom = opts.extra?.[key];
    if (custom) return custom(route);
    if (key === "GET /me") return opts.signedIn ? json(route, me) : json(route, { error: "unauthorized", message: "Sign in" }, 401);
    if (key === "GET /agents") return json(route, opts.signedIn ? [agent] : []);
    if (key === "GET /overview") return json(route, { agentCount: 1, kpis: null, series: [], latest: [] });
    if (key === "GET /leaderboard") return json(route, []);
    if (key.startsWith("GET /agents/") && key.endsWith("/decisions")) return json(route, []);
    return json(route, { error: "not_found", message: "Not mocked" }, 404);
  });
}

test.describe("every page", () => {
  for (const width of [1360, 390]) {
    test(`renders without errors or sideways scroll at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await mockApi(page, { signedIn: false });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      for (const path of ROUTES) {
        await page.goto(path);
        await page.waitForLoadState("networkidle");
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow, `${path} scrolls sideways`).toBeLessThanOrEqual(1);
      }
      expect(errors).toEqual([]);
    });
  }
});

test("landing shows honest empty states when there is no data", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("h1")).toContainText("Agents that think.");
  await expect(page.getByText("No decisions yet").first()).toBeVisible();
  await expect(page.getByText("No agents have reported yet")).toBeVisible();
  await expect(page.locator(".mband")).toHaveCount(0); // no market reading, no market band
  await expect(page.getByText("Coming later").first()).toBeVisible();
  await expect(page.locator("p.legal")).toContainText("Paper trading uses virtual money");
  // No prototype sample numbers.
  await expect(page.getByText("$2.1M")).toHaveCount(0);
  await expect(page.getByText("Tidewater")).toHaveCount(0);
});

test("has icons, link previews, robots, sitemap and legal pages", async ({ page, request }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/^Ratinole\./);
  // The logo is artwork; the link still carries the name for screen readers.
  await expect(page.getByRole("link", { name: "Ratinole" }).first().locator("svg.bmark")).toBeVisible();
  await expect(page.getByRole("link", { name: "Ratinole on X" })).toHaveAttribute("href", "https://x.com/RatinoleTrade");
  await expect(page.locator('meta[name="twitter:site"]')).toHaveAttribute("content", "@RatinoleTrade");
  await expect(page.locator('link[rel="icon"]').first()).toHaveAttribute("href", /icon|favicon/);
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute("content", /^https:\/\/ratinole\.trade\/opengraph-image/);
  await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute("content", "summary_large_image");
  for (const path of ["/favicon.ico", "/icon.svg", "/apple-icon.png", "/opengraph-image.png", "/manifest.webmanifest"]) {
    expect((await request.get(path)).status(), path).toBe(200);
  }
  const robots = await (await request.get("/robots.txt")).text();
  expect(robots).toContain("Disallow: /api/");
  expect(robots).toContain("Sitemap: https://ratinole.trade/sitemap.xml");
  expect(await (await request.get("/sitemap.xml")).text()).toContain("https://ratinole.trade/privacy");
  await page.getByRole("link", { name: "Privacy" }).click();
  await expect(page.getByRole("heading", { name: "Privacy", level: 1 })).toBeVisible();
  await expect(page.getByText(/Draft, pending legal review/)).toBeVisible();
});

test("app pages ask a signed-out visitor to connect a wallet", async ({ page }) => {
  await mockApi(page, { signedIn: false });
  await page.goto("/app/agents");
  await expect(page.getByRole("heading", { name: "Connect a wallet" })).toBeVisible();
});

test("studio: sentence, plan, backtest with warnings, launch", async ({ page }) => {
  const calls: string[] = [];
  await mockApi(page, {
    signedIn: true,
    extra: {
      "POST /intake": (r) => {
        calls.push("intake");
        return json(r, {
          ok: true,
          plan,
          rows: [
            { label: "Market", lines: ["ETH / USDG"] },
            { label: "Buy when", lines: ["RSI is below 30"] },
          ],
          checks: [{ pass: true, label: "Has a loss limit" }],
          notes: ["No size was given, so each trade uses 25% of cash."],
          notChecked: [],
        });
      },
      "POST /backtests": (r) => {
        calls.push("backtest");
        return json(r, { id: "bt1" });
      },
      "GET /backtests/bt1": (r) =>
        json(r, {
          id: "bt1",
          status: "done",
          sentence: "s",
          plan,
          market: "ETH",
          marketLabel: "ETH / USDG",
          source: "Binance ETHUSDT hourly",
          label: "Price signals only",
          createdAt: "2026-11-19T10:00:00.000Z",
          result: {
            from: "2026-08-21T09:00:00.000Z",
            split: "2026-10-20T09:00:00.000Z",
            to: "2026-11-19T08:00:00.000Z",
            candles: 2883,
            costPct: 0.1,
            tunedDays: 60,
            unseenDays: 30,
            tunedReturnPct: 2.96,
            unseenReturnPct: -2.53,
            holdingTunedPct: -2.26,
            holdingUnseenPct: -24.44,
            maxDrawdownPct: -2.58,
            tunedTrades: 6,
            unseenTrades: 4,
            paramsText: ["Buys only when confidence is at least 50%, chosen on the tuning days."],
            warnings: ["Only 4 buys and sells on the unseen days: too few to tell skill from luck. Treat the result as a rough guide."],
            curve: [
              { t: "2026-08-21T09:00:00.000Z", strategy: 100, holding: 99.9 },
              { t: "2026-11-19T08:00:00.000Z", strategy: 100.4, holding: 73.8 },
            ],
          },
        }),
      "POST /agents": (r) => {
        calls.push("launch");
        return json(r, agent, 201);
      },
    },
  });
  await page.goto("/app/studio");
  await page.getByRole("button", { name: "Understand" }).click();
  await expect(page.getByText("RSI is below 30")).toBeVisible();
  await expect(page.getByText("No size was given")).toBeVisible();
  await page.getByRole("button", { name: "Looks right, run backtest" }).click();
  await expect(page.getByText("Read these numbers with care")).toBeVisible();
  await expect(page.getByText(/too few to tell skill from luck/)).toBeVisible();
  await expect(page.getByText("−2.5%").first()).toBeVisible();
  await page.getByRole("button", { name: "Launch in paper mode" }).click();
  await expect(page).toHaveURL(/\/app\/agents$/);
  expect(calls).toEqual(["intake", "backtest", "launch"]);
});

test("my agents: delete asks first, then archives", async ({ page }) => {
  let deleted = false;
  await mockApi(page, {
    signedIn: true,
    extra: {
      "DELETE /agents/ag1": (r) => {
        deleted = true;
        return json(r, { ok: true });
      },
    },
  });
  await page.goto("/app/agents");
  page.once("dialog", (d) => void d.dismiss());
  await page.getByRole("button", { name: "Delete" }).click();
  expect(deleted).toBe(false);
  page.once("dialog", (d) => {
    expect(d.message()).toMatch(/past decisions stay on record/);
    void d.accept();
  });
  await page.getByRole("button", { name: "Delete" }).click();
  await expect.poll(() => deleted).toBe(true);
});

test("settings: saves the wallet's limits", async ({ page }) => {
  let sent: unknown = null;
  await mockApi(page, {
    signedIn: true,
    extra: {
      "PATCH /me": (r) => {
        sent = r.request().postDataJSON();
        return json(r, { ...me, maxSizePct: 20, dailyLossCapPct: 2 });
      },
    },
  });
  await page.goto("/app/settings");
  await page.getByLabel(/Largest share of cash per trade/).fill("20");
  await page.getByLabel(/Daily loss cap/).fill("2");
  await page.getByRole("button", { name: "Save limits" }).click();
  await expect(page.getByText("Limits saved")).toBeVisible();
  expect(sent).toEqual({ maxSizePct: 20, dailyLossCapPct: 2 });
});

test("leaderboard: ranked agents first, newer ones listed as not ranked", async ({ page }) => {
  const row = (name: string, edgePct: number, ranked: boolean) => ({
    agentId: name,
    name,
    market: "ETH",
    marketLabel: "ETH / USDG",
    mode: "paper",
    returnPct: edgePct,
    holdingPct: 0,
    edgePct,
    maxDrawdownPct: -1,
    daysLive: ranked ? 9 : 2,
    decisions: 50,
    ranked,
  });
  await mockApi(page, { signedIn: false, extra: { "GET /leaderboard": (r) => json(r, [row("Old", 1, true), row("New", 5, false)]) } });
  await page.goto("/app/leaderboard");
  await expect(page.getByText("1. Old")).toBeVisible();
  await expect(page.getByText(/Not ranked yet/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy" }).first()).toBeDisabled();
});

test("wallet picker: popular wallets with logos when none is installed", async ({ page }) => {
  await mockApi(page, { signedIn: false });
  await page.goto("/app/agents");
  await page.locator(".panel.connect").getByRole("button", { name: "Connect wallet" }).click();
  const dialog = page.getByRole("dialog", { name: "Connect a wallet" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("No wallet found in this browser")).toBeVisible();
  for (const name of ["MetaMask", "Rabby", "Coinbase Wallet", "OKX Wallet", "Phantom", "Trust Wallet"]) {
    const row = dialog.getByRole("link", { name: new RegExp(name) });
    await expect(row).toBeVisible();
    await expect(row.locator("img")).toHaveJSProperty("complete", true);
    expect(await row.locator("img").evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("wallet picker: an installed wallet appears with its own logo and signs in", async ({ page }) => {
  // A fake wallet that announces itself the standard way (EIP-6963), as MetaMask, Rabby and others do.
  await page.addInitScript(() => {
    const account = "0x7a3f00000000000000000000000000000000091c";
    let approved = false; // like a real wallet: no accounts until the user approves the site
    const provider = {
      request: async ({ method }: { method: string }) => {
        if (method === "eth_requestAccounts") {
          approved = true;
          return [account];
        }
        if (method === "eth_accounts") return approved ? [account] : [];
        if (method === "eth_chainId") return "0x1237";
        if (method === "personal_sign") return `0x${"ab".repeat(65)}`;
        if (method === "wallet_requestPermissions" || method === "wallet_getPermissions") return [{ parentCapability: "eth_accounts" }];
        return null;
      },
      on: () => undefined,
      removeListener: () => undefined,
    };
    const icon = "data:image/svg+xml;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="8" fill="#6A5ACD"/></svg>');
    const detail = Object.freeze({ info: { uuid: "1b2c3d4e-0000-4000-8000-000000000001", name: "Test Wallet", icon, rdns: "xyz.testwallet" }, provider });
    const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
    window.addEventListener("eip6963:requestProvider", announce);
    announce();
  });
  let verified = false;
  await mockApi(page, {
    signedIn: false,
    extra: {
      "GET /auth/nonce": (route) => json(route, { nonce: "n0nce1234567" }),
      "POST /auth/verify": (route) => {
        verified = true;
        return json(route, me);
      },
    },
  });
  await page.goto("/app/agents");
  await page.locator(".panel.connect").getByRole("button", { name: "Connect wallet" }).click();
  const dialog = page.getByRole("dialog", { name: "Connect a wallet" });
  const row = dialog.getByRole("button", { name: /Test Wallet/ });
  await expect(row).toBeVisible();
  await expect(row.getByText("Detected")).toBeVisible();
  expect(await row.locator("img").getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
  await expect(dialog.getByText("Other wallets")).toBeVisible();
  await row.click();
  await expect(dialog).toBeHidden();
  expect(verified).toBe(true);
});
