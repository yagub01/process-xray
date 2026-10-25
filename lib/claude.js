import Anthropic from "@anthropic-ai/sdk";

// Reads ANTHROPIC_API_KEY from the environment. Never expose the key to the browser.
const client = new Anthropic();
export const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";

export const isConfigured = () => !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

// Web research runs on Claude's own server-side tools, so no separate search API is needed.
export const WEB_TOOLS = [
  { type: "web_search_20260209", name: "web_search", max_uses: 10 },
  { type: "web_fetch_20260209", name: "web_fetch", max_uses: 8 }
];

const canonical = u => {
  try { const x = new URL(u); return (x.hostname.replace(/^www\./, "") + x.pathname.replace(/\/$/, "") + x.search).toLowerCase(); }
  catch { return String(u).toLowerCase(); }
};

// Streams one task to the browser as newline-delimited JSON events:
//   {type:"text", delta}       answer text as it is written
//   {type:"reset"}             a tool ran; earlier text was narration, not the answer
//   {type:"status", tool, query|url}  a web search or page read started
// Returns the stop reason and every URL that web search or web fetch actually returned,
// so the browser can drop any cited URL Claude did not really see.
export async function runStream({ content, effort = "medium", tools, maxTokens = 32000 }, emit, signal) {
  const messages = [{ role: "user", content }];
  const seen = new Map();
  const remember = (url, title, kind) => {
    if (!url) return;
    const k = canonical(url), prev = seen.get(k);
    if (!prev || (kind === "page" && prev.kind !== "page")) seen.set(k, { url, title: title || prev?.title || url, kind });
  };
  const collect = block => {
    if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const r of block.content) if (r.type === "web_search_result") remember(r.url, r.title, "search");
    } else if (block.type === "web_fetch_tool_result" && block.content?.type === "web_fetch_result") {
      remember(block.content.url, block.content.content?.title, "page");
    }
  };

  let stopReason = null;
  for (let turn = 0; turn < 6; turn++) {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: maxTokens,
      // If a safety classifier wrongly declines a normal request, Anthropic re-runs it on a
      // recommended fallback model instead of failing the visitor's request.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort },
      ...(tools ? { tools } : {}),
      messages
    }, { signal });

    const toolInputs = new Map();
    for await (const ev of stream) {
      if (ev.type === "content_block_start") {
        const b = ev.content_block;
        if (b.type === "server_tool_use") { toolInputs.set(ev.index, { name: b.name, json: "" }); emit({ type: "reset" }); }
        else if (b.type === "web_search_tool_result" || b.type === "web_fetch_tool_result") { collect(b); emit({ type: "reset" }); }
      } else if (ev.type === "content_block_delta") {
        if (ev.delta.type === "text_delta") emit({ type: "text", delta: ev.delta.text });
        else if (ev.delta.type === "input_json_delta" && toolInputs.has(ev.index)) toolInputs.get(ev.index).json += ev.delta.partial_json;
      } else if (ev.type === "content_block_stop" && toolInputs.has(ev.index)) {
        const t = toolInputs.get(ev.index);
        let input = {};
        try { input = JSON.parse(t.json || "{}"); } catch {}
        emit({ type: "status", tool: t.name, query: typeof input.query === "string" ? input.query : undefined, url: typeof input.url === "string" ? input.url : undefined });
      }
    }
    const message = await stream.finalMessage();
    message.content.forEach(collect);
    stopReason = message.stop_reason;
    // A long research turn can pause; hand the partial turn back and let Claude continue.
    if (stopReason === "pause_turn") { messages.push({ role: "assistant", content: message.content }); continue; }
    break;
  }
  return { stopReason, sources: [...seen.values()] };
}

// Maps SDK errors to stable codes the page knows how to explain.
export function errorCode(err) {
  if (err instanceof Anthropic.APIUserAbortError) return { code: "cancelled" };
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return { code: "not_configured" };
  if (err instanceof Anthropic.RateLimitError) return { code: "rate_limited" };
  if (err instanceof Anthropic.BadRequestError) return { code: "bad_request" };
  if (err instanceof Anthropic.APIConnectionError) return { code: "upstream_error" };
  if (err instanceof Anthropic.APIError) return { code: err.status === 529 ? "overloaded" : "upstream_error" };
  return { code: "upstream_error" };
}
