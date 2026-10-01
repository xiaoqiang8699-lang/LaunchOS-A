import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  async rewrites() {
    // Local UX verification against Alpha API without CORS friction.
    if (process.env.LAUNCHOS_PROXY_ALPHA === '1') {
      return [
        {
          source: '/api/v1/:path*',
          destination: 'https://api-alpha.zsaos.com/api/v1/:path*',
        },
      ];
    }
    return [];
  },
};

export default nextConfig;
