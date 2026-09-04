/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  modularizeImports: {
    '@mui/icons-material': {
      transform: '@mui/icons-material/{{member}}',
    },
  },
  // /download is a route handler now — see app/download/route.ts. The APK is
  // 72 MB and static assets are capped at 25 MiB, so it is streamed from the
  // media bucket instead of being served from public/.
};

export default nextConfig;
