import Link from "next/link";

/** /stock/xxx 里不是合法 6 位代码时的 404（公司身份不做猜测）。 */
export default function StockNotFound() {
  return (
    <main className="mx-auto w-full max-w-3xl px-6 pb-16 pt-16">
      <p className="text-[15px] text-[#f4f1ea]">这不是一个 A 股股票代码。</p>
      <p className="mt-2 text-[13px] leading-5 text-[#8d887c]">
        公司页地址是 /stock/ 加 6 位数字代码，例如 /stock/688017。身份不做猜测，请回发现页用文字搜索。
      </p>
      <Link href="/" className="mt-6 inline-block text-[13px] text-[#d9d4c8] underline decoration-white/25 hover:text-[#f4f1ea]">
        ← 回到发现
      </Link>
    </main>
  );
}
