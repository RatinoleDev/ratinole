/** @type {import('next').NextConfig} */
const apiUrl = process.env.API_INTERNAL_URL ?? "http://localhost:4000";

const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@rationale/config", "@rationale/brain"],
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiUrl}/api/:path*` }];
  },
  webpack: (config) => {
    // wagmi's optional connector deps reference these; we only use the injected connector.
    config.externals.push("pino-pretty", "lokijs", "encoding");
    return config;
  },
};

export default nextConfig;
