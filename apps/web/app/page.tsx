import type { DecisionDTO, ExampleDTO, LeaderboardRowDTO, MarketDTO } from "@rationale/config";
import { Features } from "../components/landing/Live";
import { RevealInit } from "../components/landing/Reveal";
import {
  Closing,
  Compare,
  DecisionTape,
  Faq,
  Footer,
  Hero,
  Nav,
  Pricing,
  Product,
  Safety,
  Thinks,
} from "../components/landing/Sections";
import { serverGet } from "../lib/server-api";

export const revalidate = 30;

export default async function Landing() {
  const [decisions, example, board, market] = await Promise.all([
    serverGet<DecisionDTO[]>("/public/decisions?limit=20"),
    serverGet<ExampleDTO>("/public/example"),
    serverGet<LeaderboardRowDTO[]>("/leaderboard"),
    serverGet<MarketDTO[]>("/public/market"),
  ]);
  const list = Array.isArray(decisions) ? decisions : [];
  const markets = Array.isArray(market) ? market : [];
  const latest = list[0] ?? null;
  return (
    <div id="landing">
      <RevealInit />
      <Nav />
      <Hero latest={latest} decisions={list} markets={markets} />
      <Product example={example} />
      <DecisionTape latest={latest} />
      <Thinks latest={latest} markets={markets} />
      <Features board={Array.isArray(board) ? board : []} example={example} decisions={list} />
      <Compare />
      <Safety />
      <Pricing />
      <Faq />
      <Closing />
      <Footer />
    </div>
  );
}
