import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,

  // Every corner contains app chrome in at least one responsive layout. Hiding
  // the development badge prevents it covering controls or the mobile title;
  // Next.js still surfaces compile and runtime errors when this is false.
  devIndicators: false,

  /**
   * Serve the API under the same origin as the app.
   *
   * Without this the browser must be told an absolute backend URL, which cannot
   * be right for both a laptop and a phone at once. Proxying keeps every request
   * same-origin, so the app works from any device that can reach this server,
   * and the session cookie stops depending on a CORS allowance.
   */
  async rewrites() {
    const backend = process.env.API_INTERNAL_URL ?? "http://localhost:8000/api";
    return [{ source: "/api/:path*", destination: `${backend}/:path*` }];
  },
};

export default nextConfig;
