import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "A-Atlas｜A股星图",
  description: "用自然语言，在整个 A 股公司池中发现公司。",
};

/**
 * Refocus 后的产品只有两个面：发现 `/` 与公司 `/stock/:symbol`。
 * 不再有一级导航（发现/市场/研究/我的）——极简 wordmark 固定在画布上，
 * 容器不拦指针，只有链接本身可点，公司的拖拽和抛掷不受影响。
 */
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="min-h-full bg-[#070806] text-[#f4f1ea]">
        <nav className="pointer-events-none fixed inset-x-0 top-0 z-40 flex h-10 items-center border-b border-white/10 bg-[#070806]/80 px-4">
          <Link
            href="/"
            className="pointer-events-auto text-[12.5px] font-medium tracking-wide text-[#f4f1ea] transition-colors duration-200 hover:text-white"
          >
            A-Atlas<span className="ml-1.5 text-[#8d887c]">A股星图</span>
          </Link>
        </nav>
        {children}
      </body>
    </html>
  );
}
