/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // TypeScript errors are checked separately via CI/tsc — skip during build for speed
  typescript: {
    ignoreBuildErrors: true,
  },
};

module.exports = nextConfig;
