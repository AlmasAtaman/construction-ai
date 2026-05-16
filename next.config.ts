import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(__dirname),
  },
  serverExternalPackages: [
    "@prisma/client",
    "pdfjs-dist",
    "pdf-to-img",
    "sharp",
    "@react-pdf/renderer",
    "mupdf",
  ],
  experimental: {
    serverActions: {
      bodySizeLimit: "50mb",
    },
  },
};

export default nextConfig;
