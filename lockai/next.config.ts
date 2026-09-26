import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  images: {
    unoptimized: process.env.NODE_ENV === 'development',
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'lock-ai.oss-cn-beijing.aliyuncs.com',
      },
    ],
  },
};

export default nextConfig;
