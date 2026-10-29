// Test-only Wrangler entry point: never imported by the deployed Worker.
import { createApp } from "../../worker/app";
import type { Env } from "../../worker/types";

const app = createApp();
const gates = new Map<string, { release: () => void; ready: boolean }>();

export default {
  async fetch(request: Request, env: Env, execution: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/__test/fencing/")) {
      const id = url.pathname.split("/").at(-1)!;
      const gate = gates.get(id);
      if (request.method === "POST") { gate?.release(); return new Response(null, { status: gate ? 204 : 404 }); }
      return Response.json({ ready: gate?.ready === true });
    }
    const id = request.headers.get("x-test-fencing-gate");
    if (!id) return app.fetch(request, env, execution);
    let released = false;
    const gate = { release: () => { released = true; }, ready: false };
    gates.set(id, gate);
    let batchNumber = 0;
    const targetBatch = Number(request.headers.get("x-test-fencing-batch") ?? "1");
    const db = new Proxy(env.DB, {
      get(target, property) {
        if (property === "batch") return async (statements: D1PreparedStatement[]) => {
          batchNumber += 1;
          if (batchNumber !== targetBatch) return target.batch(statements);
          gate.ready = true;
          while (!released) await new Promise((resolve) => setTimeout(resolve, 20));
          gates.delete(id);
          return target.batch(statements);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return app.fetch(request, { ...env, DB: db }, execution);
  },
};
