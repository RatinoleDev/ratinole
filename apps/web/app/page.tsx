import type { DecisionDTO, ExampleDTO, LeaderboardRowDTO } from "@rationale/config";
import {
  Bento,
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
  const [decisions, example, board] = await Promise.all([
    serverGet<DecisionDTO[]>("/public/decisions?limit=20"),
    serverGet<ExampleDTO>("/public/example"),
    serverGet<LeaderboardRowDTO[]>("/leaderboard"),
  ]);
  const list = Array.isArray(decisions) ? decisions : [];
  const latest = list[0] ?? null;
  return (
    <div id="landing">
      <Nav />
      <Hero latest={latest} decisions={list} />
      <Product example={example} />
      <DecisionTape latest={latest} />
      <Thinks latest={latest} />
      <Bento board={Array.isArray(board) ? board.filter((r) => r.ranked) : []} example={example} />
      <Compare />
      <Safety />
      <Pricing />
      <Faq />
      <Closing />
      <Footer />
    </div>
  );
}
