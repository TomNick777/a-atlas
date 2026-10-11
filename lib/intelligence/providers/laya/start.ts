import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { getLayaProvider } from "../../runtime";

const exec = promisify(execFile);
let starting: Promise<void> | null = null;
/** Fixed registered service only. No client paths, commands or model names reach a shell. */
export async function ensureLayaRuntime(): Promise<void> {
  await getLayaProvider().refreshIdentity(true);
  if (getLayaProvider().configured()) return;
  if (starting) return starting;
  const root = process.cwd();
  starting = exec(join(root, ".venv-laya", "Scripts", "python.exe"), [join(root, "scripts", "atlas_runtime.py"), "serve"], { cwd: root, windowsHide: true, timeout: 150000, maxBuffer: 65536 }).then(async () => {
    await getLayaProvider().refreshIdentity(true);
    if (!getLayaProvider().configured()) throw new Error("Laya identity is unavailable after startup");
  }).finally(() => { starting = null; });
  return starting;
}
