import { BRAND_DOMAIN } from "@rationale/config";
import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/api/"] }],
    sitemap: `https://${BRAND_DOMAIN}/sitemap.xml`,
    host: `https://${BRAND_DOMAIN}`,
  };
}
