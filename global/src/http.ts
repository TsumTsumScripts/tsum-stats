// Replies and request bodies (CONTRACT §2): JSON in and out, every reply has `ok`.
import { DAY } from "./days";

/** A refusal: the status and the contract's error code. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(code);
  }
}

export const ok = (body: Record<string, unknown> = {}, status = 200, headers: Record<string, string> = {}) =>
  Response.json({ ok: true, ...body }, { status, headers });

export const fail = (e: HttpError) => Response.json({ ok: false, error: e.code }, { status: e.status, headers: e.headers });

/** A body is at most this long once inflated. */
export const MAX_BODY = 1 << 20;

/** The body as text, inflated when gzipped; a 413 past MAX_BODY. */
export async function readText(req: Request): Promise<string> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) throw new HttpError(413, "too-large");
  if (!req.body) return "";
  let body: ReadableStream<Uint8Array> = req.body;
  const encoding = (req.headers.get("content-encoding") ?? "").trim().toLowerCase();
  if (encoding === "gzip") body = body.pipeThrough(new DecompressionStream("gzip"));
  else if (encoding !== "" && encoding !== "identity") throw new HttpError(400, "bad-request");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const chunk of body) {
      size += chunk.byteLength;
      if (size > MAX_BODY) throw new HttpError(413, "too-large");
      chunks.push(chunk);
    }
  } catch (e) {
    // A gzip stream that does not inflate is unreadable, like bad JSON.
    throw e instanceof HttpError ? e : new HttpError(400, "bad-request");
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** The body as a JSON object; an empty body is {}. */
export async function readObject(req: Request): Promise<Record<string, unknown>> {
  const text = await readText(req);
  if (text.trim() === "") return {};
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new HttpError(400, "bad-request");
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, "bad-request");
  return v as Record<string, unknown>;
}

/** The Bearer key, or "" without one. */
export function bearer(req: Request): string {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("authorization") ?? "");
  return m ? m[1] : "";
}

/** Retry-After for a refusal that lifts at the next 00:00 UTC. */
export function untilMidnight(nowMs: number): Record<string, string> {
  const s = nowMs / 1000;
  return { "Retry-After": String(Math.max(1, Math.ceil(DAY - (s % DAY)))) };
}

/** Epoch seconds as the API writes times, "2026-10-14T18:05:00Z"; null stays null. */
export const isoTime = (sec: number | null | undefined) =>
  sec === null || sec === undefined ? null : new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
