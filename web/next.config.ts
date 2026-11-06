import os from "node:os";
import path from "node:path";
import type { NextConfig } from "next";

// This machine's LAN IPv4 addresses (e.g. 192.168.68.127), so other devices on
// the network can use the dev server. Extra hosts: ALLOWED_DEV_ORIGINS=a.local,b.local
const lanIps = Object.values(os.networkInterfaces())
  .flat()
  .filter((i) => i && i.family === "IPv4" && !i.internal)
  .map((i) => i!.address);

const nextConfig: NextConfig = {
  /* config options here */
  allowedDevOrigins: [
    ...lanIps,
    ...(process.env.ALLOWED_DEV_ORIGINS?.split(",").filter(Boolean) ?? []),
  ],
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    // Repo root: the web app type-imports the API server from ../src
    root: path.join(__dirname, ".."),
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  
};

export default nextConfig;
