import { isConfigured } from "../lib/claude.js";
import { accessCodeRequired } from "../lib/guard.js";

// Tells the page whether the service is ready and whether visitors need an access code.
export default function handler(req, res) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({ configured: isConfigured(), accessCodeRequired: accessCodeRequired() }));
}
