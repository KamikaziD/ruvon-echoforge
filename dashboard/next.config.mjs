/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  env: {
    NEXT_PUBLIC_BRIDGE_URL: process.env.NEXT_PUBLIC_BRIDGE_URL || "http://localhost:8765",
    NEXT_PUBLIC_BRIDGE_WS:  process.env.NEXT_PUBLIC_BRIDGE_WS  || "ws://localhost:8765",
  },
};

export default nextConfig;
