import { BRAND_DOMAIN } from "@rationale/config";
import type { MetadataRoute } from "next";

const PAGES: { path: string; priority: number }[] = [
  { path: "", priority: 1 },
  { path: "/app/studio", priority: 0.8 },
  { path: "/app/leaderboard", priority: 0.7 },
  { path: "/terms", priority: 0.3 },
  { path: "/privacy", priority: 0.3 },
  { path: "/risk", priority: 0.3 },
];

export default function sitemap(): MetadataRoute.Sitemap {
  return PAGES.map((p) => ({ url: `https://${BRAND_DOMAIN}${p.path}`, changeFrequency: "weekly", priority: p.priority }));
}
