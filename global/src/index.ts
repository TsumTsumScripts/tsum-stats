// The tsum-global Worker (CONTRACT §2): the upload API, the published files
// from R2, the page's static files, and the hourly job.
import { adminPost, contributors } from "./admin";
import { authContributor, join, me, unlink } from "./contributors";
import { sameSecret } from "./crypto";
import { serveData } from "./data";
import type { Env } from "./env";
import { HttpError, bearer, fail, requireJson } from "./http";
import { postRounds } from "./ingest";
import { runJob } from "./job";

const ADMIN_POSTS = ["ban", "unban", "merge", "rebuild", "restore", "rollup", "resend"];

/** The API's routes: path → [method, handler]. */
type Handler = (req: Request, env: Env, nowMs: number) => Promise<Response>;
const ROUTES: Record<string, [string, Handler]> = {
  "/api/v1/join": ["POST", join],
  "/api/v1/rounds": ["POST", async (req, env, now) => postRounds(req, env, await authContributor(req, env), now)],
  "/api/v1/me": ["GET", async (req, env, now) => me(env, await authContributor(req, env), now)],
  "/api/v1/me/unlink": ["POST", async (req, env, now) => unlink(env, await authContributor(req, env), now)],
  "/api/v1/admin/contributors": ["GET", async (req, env) => (await authAdmin(req, env), contributors(env))],
};
for (const action of ADMIN_POSTS) {
  ROUTES["/api/v1/admin/" + action] = ["POST", async (req, env, now) => (await authAdmin(req, env), adminPost(action, req, env, now))];
}

async function authAdmin(req: Request, env: Env): Promise<void> {
  if (!(await sameSecret(bearer(req), env.ADMIN_KEY))) throw new HttpError(401, "unauthorized");
}

/** Answers one request; nowMs is the server's clock, which tests set. */
export async function handle(req: Request, env: Env, ctx: ExecutionContext, nowMs = Date.now()): Promise<Response> {
  const path = new URL(req.url).pathname;
  if (path.startsWith("/data/global/")) return serveData(req, env, ctx, path.slice("/data/global/".length));
  if (!path.startsWith("/api/")) return env.ASSETS.fetch(req);
  try {
    // Keys and device hashes made without the secret would never match again.
    if (!env.DEVICE_KEY) throw new Error("DEVICE_KEY is not set");
    const route = Object.hasOwn(ROUTES, path) ? ROUTES[path] : undefined;
    if (!route) throw new HttpError(404, "not-found");
    if (req.method !== route[0]) throw new HttpError(405, "method", { Allow: route[0] });
    if (req.method === "POST") requireJson(req);
    return await route[1](req, env, nowMs);
  } catch (e) {
    if (e instanceof HttpError) return fail(e);
    console.error(path, e);
    return fail(new HttpError(500, "internal"));
  }
}

export default {
  fetch: (req, env, ctx) => handle(req, env, ctx),
  async scheduled(controller, env) {
    if (!env.DEVICE_KEY) throw new Error("DEVICE_KEY is not set");
    console.log("rollup", JSON.stringify(await runJob(env, controller.scheduledTime)));
  },
} satisfies ExportedHandler<Env>;
