/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // §4: components read from a DataProvider. DATA_SOURCE picks the implementation
  // and is inlined here so the same name works on the server and in the browser.
  // "sim" ships the P0 simulator; "live" is P1 and currently throws.
  env: {
    DATA_SOURCE: process.env.DATA_SOURCE ?? 'sim',
  },
};

export default nextConfig;
