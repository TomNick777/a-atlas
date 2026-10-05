import { readFile } from "node:fs/promises";
import path from "node:path";

const LOGO_DIR = path.join(process.cwd(), "data", "raw", "logos");
const CODE = /^\d{6}$/;

/** 公司 logo 供图：data/raw/logos/{code}.png。内容按代码不变，缓存一年。 */
export async function GET(_request: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  if (!CODE.test(code)) return new Response(null, { status: 400 });
  try {
    const png = await readFile(path.join(LOGO_DIR, `${code}.png`));
    return new Response(new Uint8Array(png), {
      headers: {
        "content-type": "image/png",
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return new Response(null, { status: 404 });
  }
}
