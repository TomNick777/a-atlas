import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 开发角标默认悬在左下角，会压住「设置」按钮，挪到右下角。
  devIndicators: {
    position: "bottom-right",
  },
  // Next 16 dev 资源默认按跨域拦截：headless 走查（playwright-core + Edge）与
  // 本机 Harbor 探活都从 127.0.0.1 进来，缺省 Host 判定会拦掉 dev chunk，
  // 症状是 SSR HTML 正常但 hydration 永不完成（Phase 2 §24 走查实锤）。
  allowedDevOrigins: ["127.0.0.1", "localhost"],
};

export default nextConfig;
