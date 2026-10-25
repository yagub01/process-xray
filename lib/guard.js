// Protections that keep a public page from running up your API bill:
// an optional access code, an optional allowed-origin check, per-visitor rate limits,
// a global daily cap, and strict size limits on everything a visitor sends.

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
const LIMITS = {
  perHour: num(process.env.RATE_LIMIT_PER_HOUR, 20),
  researchPerHour: num(process.env.RESEARCH_LIMIT_PER_HOUR, 5),
  dailyCap: num(process.env.DAILY_REQUEST_CAP, 300)
};
export const accessCodeRequired = () => !!process.env.ACCESS_CODE;

export function clientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  return (Array.isArray(xf) ? xf[0] : xf || "").split(",")[0].trim() || req.headers["x-real-ip"] || req.socket?.remoteAddress || "unknown";
}

export function checkAccess(req) {
  const code = process.env.ACCESS_CODE;
  if (code && req.headers["x-access-code"] !== code) return { status: 401, code: "access_denied" };
  const allowed = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  const origin = req.headers.origin;
  if (allowed.length && origin && !allowed.includes(origin)) return { status: 403, code: "forbidden_origin" };
  return null;
}

/* ---------- rate limits ---------- */
// With Upstash Redis configured, limits are shared across every server instance.
// Without it, each instance counts on its own: fine for testing, not for a busy launch.
let redisLimiter;
async function upstash() {
  if (redisLimiter !== undefined) return redisLimiter;
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return (redisLimiter = null);
  const [{ Ratelimit }, { Redis }] = await Promise.all([import("@upstash/ratelimit"), import("@upstash/redis")]);
  const redis = Redis.fromEnv();
  redisLimiter = {
    all: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(LIMITS.perHour, "1 h"), prefix: "pxray:all" }),
    research: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(LIMITS.researchPerHour, "1 h"), prefix: "pxray:research" }),
    daily: new Ratelimit({ redis, limiter: Ratelimit.fixedWindow(LIMITS.dailyCap, "1 d"), prefix: "pxray:daily" })
  };
  return redisLimiter;
}
const memory = new Map();
function memoryHit(key, limit, windowMs) {
  const now = Date.now(), arr = (memory.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= limit) { memory.set(key, arr); return { ok: false, retryAfter: Math.ceil((windowMs - (now - arr[0])) / 1000) }; }
  arr.push(now); memory.set(key, arr);
  return { ok: true };
}

export async function checkRate(ip, task) {
  const r = await upstash();
  if (r) {
    const daily = await r.daily.limit("global");
    if (!daily.success) return { status: 429, code: "daily_cap", retryAfter: Math.ceil((daily.reset - Date.now()) / 1000) };
    const all = await r.all.limit(ip);
    if (!all.success) return { status: 429, code: "rate_limited", retryAfter: Math.ceil((all.reset - Date.now()) / 1000) };
    if (task === "research") {
      const rs = await r.research.limit(ip);
      if (!rs.success) return { status: 429, code: "rate_limited", retryAfter: Math.ceil((rs.reset - Date.now()) / 1000) };
    }
    return null;
  }
  const daily = memoryHit("daily", LIMITS.dailyCap, 864e5);
  if (!daily.ok) return { status: 429, code: "daily_cap", retryAfter: daily.retryAfter };
  const all = memoryHit("all:" + ip, LIMITS.perHour, 36e5);
  if (!all.ok) return { status: 429, code: "rate_limited", retryAfter: all.retryAfter };
  if (task === "research") {
    const rs = memoryHit("research:" + ip, LIMITS.researchPerHour, 36e5);
    if (!rs.ok) return { status: 429, code: "rate_limited", retryAfter: rs.retryAfter };
  }
  return null;
}

/* ---------- input validation ---------- */
const TASKS = ["analyze", "refine", "research", "dive", "plan"];
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const s = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");

function cleanFiles(files) {
  return (Array.isArray(files) ? files : []).slice(0, 10)
    .map(f => ({ name: s(f?.name, 200) || "file", kind: s(f?.kind, 20) || "text", text: s(f?.text, 60000) }))
    .filter(f => f.text);
}
function cleanImages(images) {
  const out = [];
  let total = 0;
  for (const im of (Array.isArray(images) ? images : []).slice(0, 6)) {
    const data = typeof im?.data === "string" ? im.data : "";
    if (!IMAGE_TYPES.includes(im?.media_type) || !data || data.length > 1_400_000 || !/^[A-Za-z0-9+/=]+$/.test(data)) continue;
    if ((total += data.length) > 3_600_000) break;
    out.push({ media_type: im.media_type, data, label: s(im.label, 200) || "image" });
  }
  return out;
}
function cleanInput(p) {
  return {
    mode: p?.mode === "research" ? "research" : "describe",
    desc: s(p?.desc, 100000), company: s(p?.company, 200), process: s(p?.process, 300), notes: s(p?.notes, 8000),
    team: s(p?.team, 300), volume: s(p?.volume, 300), tools: s(p?.tools, 500), goal: s(p?.goal, 100),
    depth: p?.depth === "complex" ? "complex" : "default",
    files: cleanFiles(p?.files), images: cleanImages(p?.images)
  };
}
function cleanData(d) {
  if (!d || typeof d !== "object" || !Array.isArray(d.steps)) return null;
  return JSON.stringify(d).length <= 400000 ? d : null;
}

// Returns {task, payload} with only known, size-capped fields, or an error.
export function validate(body) {
  const task = body?.task, p = body?.payload || {};
  if (!TASKS.includes(task)) return { error: { status: 400, code: "bad_request" } };
  if (task === "analyze") {
    const inp = cleanInput({ ...p, mode: "describe" });
    if (inp.desc.length < 20 && !inp.files.length && !inp.images.length) return { error: { status: 400, code: "bad_request" } };
    return { task, payload: inp };
  }
  if (task === "research") {
    const inp = cleanInput({ ...p, mode: "research" });
    if (!inp.company || !inp.process) return { error: { status: 400, code: "bad_request" } };
    return { task, payload: inp };
  }
  const data = cleanData(p.data);
  if (!data) return { error: { status: 400, code: "bad_request" } };
  if (task === "refine") {
    const feedback = s(p.feedback, 6000);
    if (!feedback) return { error: { status: 400, code: "bad_request" } };
    return { task, payload: { data, input: cleanInput(p.input), feedback } };
  }
  if (task === "dive") {
    const step = data.steps.find(x => x?.id === p.stepId);
    return step ? { task, payload: { data, step } } : { error: { status: 400, code: "bad_request" } };
  }
  const opp = (Array.isArray(data.opportunities) ? data.opportunities : []).find(x => x?.id === p.oppId);
  return opp ? { task, payload: { data, opp } } : { error: { status: 400, code: "bad_request" } };
}
