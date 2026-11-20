/** @type {import('next').NextConfig} */
const apiUrl = process.env.API_INTERNAL_URL ?? "http://127.0.0.1:4000";
// The browser reads vaults straight from the chain. A rehearsal build may point at a local fork instead.
const rpcOrigin = process.env.NEXT_PUBLIC_CHAIN_RPC_URL ? new URL(process.env.NEXT_PUBLIC_CHAIN_RPC_URL).origin : "https://robinhood.drpc.org";

// Next 14 hydrates with inline scripts, so script-src needs 'unsafe-inline'
// unless nonces are added. Everything else is locked to this origin. Fonts are
// self-hosted by next/font. Dev mode needs eval, so the policy is production-only.
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  `connect-src 'self' ${rpcOrigin}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
  ...(process.env.NODE_ENV === "production" ? [{ key: "Content-Security-Policy", value: csp }] : []),
];

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ["@rationale/config", "@rationale/brain"],
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiUrl}/api/:path*` }];
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  webpack: (config) => {
    // wagmi's optional connector deps reference these; we only use the injected connector.
    config.externals.push("pino-pretty", "lokijs", "encoding");
    return config;
  },
};

export default nextConfig;
