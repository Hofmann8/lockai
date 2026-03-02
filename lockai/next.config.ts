import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  serverExternalPackages: ['pdfjs-dist'],
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'funkandlove-main.s3.bitiful.net',
      },
      {
        protocol: 'https',
        hostname: 'funkandlove-ai.s3.bitiful.net',
      },
      {
        protocol: 'https',
        hostname: 'funkandlove-cloud-public.s3.bitiful.net',
      },
    ],
  },
};

export default nextConfig;
