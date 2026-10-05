export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { warmMeaning } = await import("./lib/text/embed");
  void warmMeaning();
  // Product Evidence Layer (§46): startup self-check runs in the background —
  // register must return before the server is ready to serve.
  const [{ initRuntime }, { catchUpRollups }] = await Promise.all([
    import("./lib/telemetry/runtime"),
    import("./lib/telemetry/rollup"),
  ]);
  // Refocus: Vibe research job queue (restoreQueue) retired with the service.
  void initRuntime().catch(() => undefined);
  void catchUpRollups().catch(() => undefined);
}
