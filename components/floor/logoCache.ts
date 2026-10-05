/**
 * LOGO 卡面的图片注册表：按代码懒加载 /api/logos/{code}，
 * 失败负缓存（缺图只花一次请求），到达即通知（图集单格重绘见 CompanyFloor）。
 */

const images = new Map<string, HTMLImageElement>();
const pending = new Set<string>();
const failed = new Set<string>();
const loaded: string[] = [];
const listeners = new Set<() => void>();

/** 已加载则返回图；否则发起加载并返回 null（调用方先落文字面）。 */
export function logoFor(code: string): HTMLImageElement | null {
  const hit = images.get(code);
  if (hit) return hit;
  if (pending.has(code) || failed.has(code)) return null;
  pending.add(code);
  const image = new Image();
  image.decoding = "async";
  image.onload = () => {
    pending.delete(code);
    images.set(code, image);
    loaded.push(code);
    for (const listener of listeners) listener();
  };
  image.onerror = () => {
    pending.delete(code);
    failed.add(code);
  };
  image.src = `/api/logos/${code}`;
  return null;
}

/** 自上次取走以来到达的代码；图集只重绘这批格。 */
export function takeLoadedLogos(): string[] {
  return loaded.splice(0, loaded.length);
}

export function subscribeLogos(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
