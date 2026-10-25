import { runStream, errorCode, isConfigured, WEB_TOOLS } from "../lib/claude.js";
import { analyzePrompt, refinePrompt, researchPrompt, divePrompt, planPrompt } from "../lib/prompts.js";
import { checkAccess, checkRate, clientIp, validate } from "../lib/guard.js";

const sendJson = (res, status, body) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
};

// Images go first so Claude reads them before the instructions that refer to them.
const withImages = (text, images) => images?.length
  ? [...images.map(im => ({ type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } })), { type: "text", text }]
  : text;

function buildTask(task, p) {
  switch (task) {
    case "analyze": return { content: withImages(analyzePrompt(p), p.images), effort: p.depth === "complex" ? "high" : "medium" };
    case "research": return { content: withImages(researchPrompt(p), p.images), effort: p.depth === "complex" ? "high" : "medium", tools: WEB_TOOLS };
    case "refine": return { content: refinePrompt(p.data, p.input, p.feedback), effort: p.input?.depth === "complex" ? "high" : "medium" };
    case "dive": return { content: divePrompt(p.data, p.step), effort: "medium", maxTokens: 16000 };
    case "plan": return { content: planPrompt(p.data, p.opp), effort: "medium", maxTokens: 16000 };
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return sendJson(res, 405, { code: "bad_request" }); }
  if (!isConfigured()) return sendJson(res, 503, { code: "not_configured" });

  const denied = checkAccess(req);
  if (denied) return sendJson(res, denied.status, { code: denied.code });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = null; } }
  const v = validate(body);
  if (v.error) return sendJson(res, v.error.status, { code: v.error.code });

  const limited = await checkRate(clientIp(req), v.task);
  if (limited) {
    if (limited.retryAfter) res.setHeader("Retry-After", String(limited.retryAfter));
    return sendJson(res, limited.status, { code: limited.code, retryAfter: limited.retryAfter });
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Accel-Buffering", "no");
  const emit = event => { if (!res.writableEnded) res.write(JSON.stringify(event) + "\n"); };

  // Stop paying for the answer as soon as the visitor presses Stop or leaves.
  const abort = new AbortController();
  res.on("close", () => { if (!res.writableEnded) abort.abort(); });

  try {
    const { stopReason, sources } = await runStream(buildTask(v.task, v.payload), emit, abort.signal);
    if (stopReason === "refusal") emit({ type: "error", code: "refused" });
    else emit({ type: "done", truncated: stopReason === "max_tokens", sources });
  } catch (err) {
    const e = errorCode(err);
    if (e.code !== "cancelled") console.error(`[run:${v.task}]`, err?.status || "", err?.message || err);
    emit({ type: "error", ...e });
  }
  res.end();
}
