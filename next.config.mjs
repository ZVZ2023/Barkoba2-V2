/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // /api/version reads the VERSION file at runtime. Next only ships files it
  // can trace, and a readFileSync built from path.join(process.cwd(), ...) is
  // not traceable statically — so without this the route works locally and
  // returns null once deployed.
  experimental: {
    outputFileTracingIncludes: {
      "/api/version": ["./VERSION"],
    },
  },
};

export default nextConfig;
