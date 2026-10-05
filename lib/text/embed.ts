import type { FeatureExtractionPipeline } from "@huggingface/transformers";
import path from "node:path";

/** bge-small-zh-v1.5. The English bge-small is 384 wide; this one is 512. */
export const DIM = 512;
export const MODEL = "Xenova/bge-small-zh-v1.5";

const ASKING = "为这个句子生成表示以用于检索相关文章：";

const store = globalThis as unknown as { __bgeZh?: Promise<FeatureExtractionPipeline> };

function model(): Promise<FeatureExtractionPipeline> {
  store.__bgeZh ??= (async () => {
    const { pipeline, env } = await import("@huggingface/transformers");
    // 模型缓存放仓库内（gitignored），npm ci 重装依赖不丢；本机网络到不了
    // huggingface.co，空缓存会让每次搜索在 10s 连接超时上失败。
    env.cacheDir = path.join(process.cwd(), ".cache", "huggingface");
    return pipeline("feature-extraction", MODEL, { dtype: "q8" });
  })();
  return store.__bgeZh;
}

function rows(data: Float32Array, count: number): Float32Array[] {
  return Array.from({ length: count }, (_, i) => data.slice(i * DIM, (i + 1) * DIM));
}

export async function embedPassages(texts: string[]): Promise<Float32Array[]> {
  if (!texts.length) return [];
  const embed = await model();
  const out = await embed(texts.map((text) => text || "无"), { pooling: "cls", normalize: true });
  return rows(out.data as Float32Array, texts.length);
}

export async function embedQuery(query: string): Promise<Float32Array> {
  const embed = await model();
  const out = await embed(ASKING + query, { pooling: "cls", normalize: true });
  return (out.data as Float32Array).slice(0, DIM);
}

export function dot(a: ArrayLike<number>, b: ArrayLike<number>, offset = 0): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[offset + i];
  return sum;
}

export const warmMeaning = () => model().catch(() => undefined);
