/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // /api/version reads the VERSION file at runtime. Next only ships files it
  // can trace, and a readFileSync built from path.join(process.cwd(), ...) is
  // not traceable statically — so without this the route works locally and
  // returns null once deployed.
  // Every route that reads the VERSION file needs an entry here. Next cannot
  // statically trace a readFileSync built from process.cwd(), so an untraced
  // route returns null in production while working perfectly in dev.
  experimental: {
    outputFileTracingIncludes: {
      "/api/version": ["./VERSION"],
      "/": ["./VERSION"],
      "/play/ai": ["./VERSION"],
      "/compose": ["./VERSION"],
      "/play": ["./VERSION"],
      "/game/[id]": ["./VERSION"],
    },
  },
};

export default nextConfig;
