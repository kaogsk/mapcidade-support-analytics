const api = process.env.ANALYTICS_API_ORIGIN ?? "http://127.0.0.1:4201";

export default {
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${api}/api/:path*` }];
  },
};
