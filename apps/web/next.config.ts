import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    middlewareClientMaxBodySize: "1000gb"
  },
  transpilePackages: [
    "@core/ui",
    "@core/cases",
    "@core/db",
    "@core/forensics",
    "@core/queue",
    "@core/search",
    "@core/shared",
    "@core/storage",
    "@core/parsers"
  ]
};

export default nextConfig;
