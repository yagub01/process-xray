# Process X-Ray

Describe a work process, attach SOPs, PDFs, Word files or whiteboard photos, or name a company to research on the web. Process X-Ray builds a swimlane process map, measures waste and wait time, and ranks ways to remove, simplify or automate each step, with Claude and with other tools.

It is a single web page (`public/index.html`) plus one small server function (`api/run.js`) that calls the Claude API. The server builds every prompt itself, so visitors can only run this product's tasks and your API key never reaches the browser.

---

## What you need

- A **Claude API key** from the [Anthropic Console](https://console.anthropic.com) (Settings → API Keys). Add a payment method there.
- A free **GitHub** account (to store the code).
- A free **Vercel** account (to host the site). Sign up with your GitHub account.
- For local testing only: **Node.js 20 or newer**.

---

## Run it on your computer

```bash
npm install
```

Create a file named `.env.local` in this folder with your key:

```
ANTHROPIC_API_KEY=sk-ant-...
```

Then start it:

```bash
npm run dev
```

Open http://localhost:3000.

---

## Put it online with Vercel

1. **Put the code on GitHub.** Create a new private repository on github.com, then upload this folder to it (GitHub Desktop is the easiest way). The `.gitignore` already keeps `node_modules` and `.env.local` out.
2. **Import it in Vercel.** In Vercel, choose **Add New → Project**, pick the repository, leave the framework as **Other**, and click **Deploy**. No build command is needed.
3. **Add your API key.** In the project, open **Settings → Environment Variables**, add `ANTHROPIC_API_KEY` with your key, then go to **Deployments** and choose **Redeploy** on the latest one.
4. **Connect your domain.** Open **Settings → Domains** and add your domain. Vercel shows the DNS records to set at your domain registrar.

Every push to GitHub redeploys the site automatically.

---

## Settings

Set these in Vercel under **Settings → Environment Variables** (or in `.env.local` for local testing). Only the API key is required.

| Variable | What it does | Default |
|---|---|---|
| `ANTHROPIC_API_KEY` | Your Claude API key. Required. | none |
| `CLAUDE_MODEL` | Which Claude model to use. | `claude-opus-5-5` |
| `ACCESS_CODE` | If set, visitors must enter this code before running anything. Good for a private beta. | off |
| `ALLOWED_ORIGINS` | Comma-separated list of your site's addresses, e.g. `https://yourdomain.com`. Blocks other websites from using your server. | off |
| `RATE_LIMIT_PER_HOUR` | Runs per visitor per hour, all tasks combined. | `20` |
| `RESEARCH_LIMIT_PER_HOUR` | Company research runs per visitor per hour. | `5` |
| `DAILY_REQUEST_CAP` | Total runs per day across all visitors. A hard ceiling on your spend. | `300` |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Shared rate limits across all server instances (see below). | off |

---

## Before you launch publicly

1. **Set a monthly spend limit in the Anthropic Console** (Settings → Limits). This is your real safety net: whatever happens, the bill cannot pass it.
2. **Add Upstash Redis for reliable rate limits.** Without it, limits are counted separately by each server instance, which is fine for testing but easy to exceed on a busy day. In Vercel open **Storage → Create → Upstash (Redis)**, connect it to the project, and redeploy. The two `UPSTASH_…` variables are added for you.
3. **Set `ALLOWED_ORIGINS`** to your domain.
4. **Consider `ACCESS_CODE`** for a soft launch, then remove it when you are ready for everyone.
5. **Add a privacy policy and terms.** Visitors' text and files are sent to your server and to Anthropic's API to produce each analysis. Anthropic does not train on API data by default; say so, and link to your policy from the footer in `public/index.html`.

---

## What it costs to run

You pay Anthropic per use. Rough estimates with Claude Opus 5.5 ($4 per million input tokens, $20 per million output tokens):

- **Map from a description:** about $0.10 to $0.40.
- **Company research:** about $0.50 to $1.50, because Claude reads several web pages. Web searches add about $0.01 each.
- **Step breakdown or implementation plan:** about $0.05 to $0.15.
- **Deep depth** costs more than Standard because Claude thinks longer.

Check your real numbers in the Anthropic Console after a few runs. For lower costs, set `CLAUDE_MODEL=claude-sonnet-5-5` (about half the price), at some cost in quality.

Vercel's free plan covers a small site. Functions can run up to 5 minutes, which research needs. If you see timeouts on long research runs, check your plan's function duration limit.

---

## How it works

```
public/index.html   The whole page: input, map, opportunities, exports. Saved maps stay in the visitor's browser.
api/run.js          Receives a task, checks access, limits and input size, streams Claude's answer back.
api/health.js       Tells the page whether the service is configured and whether an access code is needed.
lib/prompts.js      Every prompt. Edit here to change what Claude is asked.
lib/claude.js       Calls the Claude API with streaming, web search and web fetch, and refusal fallbacks.
lib/guard.js        Access code, allowed origins, rate limits and input validation.
dev-server.js       Local test server that behaves like Vercel.
```

- **Research** uses Claude's built-in web search and web fetch tools, so no separate search service is needed. The server reports which pages Claude actually opened, and the page drops any cited link Claude didn't really see.
- **Refusal fallbacks** are switched on: if Claude's safety filter wrongly declines a normal request, Anthropic re-runs it on a recommended fallback model instead of failing.
- **Files** are read in the visitor's browser (PDF and Word text extraction, image resizing), so only text and small images are uploaded.

---

## Customizing

- **Name and text:** search `public/index.html` for "Process X-Ray".
- **Colors and fonts:** the `:root` block at the top of `public/index.html`.
- **Prompts and rules:** `lib/prompts.js`.
- **Example map shown on first visit:** `EXAMPLE` in `public/index.html`.

---

## Troubleshooting

- **"The analysis service isn't set up yet"**: `ANTHROPIC_API_KEY` is missing, or you added it without redeploying.
- **"You've reached the limit for now"**: the visitor hit `RATE_LIMIT_PER_HOUR` or `RESEARCH_LIMIT_PER_HOUR`.
- **"Today's capacity is used up"**: `DAILY_REQUEST_CAP` was reached.
- **Research stops early or times out**: try Standard depth, or check your Vercel plan's function time limit.
- **Errors in Vercel's Logs tab** start with `[run:task]` and include the API's status code.
