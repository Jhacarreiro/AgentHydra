// Connections' Jev behind a Worker, billed to the Connections Global LLC Cloudflare account (owner, 2026-10-10).
//
// Why a Worker: Workers AI's REST API needs an API token, and the vault's Cloudflare credential is an hourly OAuth lease
// that cannot be stored. A Worker reaches Workers AI through its AI binding with no token, so this one forwards
// TypeSafe-shaped Jev requests ({state, model, questions}) to `typesafe/jev` and checks one shared secret.
//
// Deploy with an AI binding named AI and a secret JEV_SECRET. POST / with `Authorization: Bearer <secret>`; the answer
// comes back in Workers AI's REST envelope {result, success} with Cloudflare's own status (402 'Insufficient balance'
// included), which hswarm's Jev client unwraps. The route line `<worker host>:<secret>` lives outside the repo
// (~/.connections/jev-route), read by dredd/lib/jev.mjs and handed to HSwarm's /api/decide with each call.

const enc = new TextEncoder();

function reply(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function authorised(request, secret) {
  const given = enc.encode((request.headers.get("authorization") || "").replace(/^Bearer\s+/i, ""));
  const want = enc.encode(secret || "");
  return want.byteLength > 0 && given.byteLength === want.byteLength && crypto.subtle.timingSafeEqual(given, want);
}

// Workers AI errors carry Cloudflare's code in the message; 2021 is the empty AI Gateway balance (HTTP 402).
function statusOf(error) {
  const message = String(error?.message || error);
  if (/\b2021\b|insufficient balance/i.test(message)) return 402;
  if (/capacity|timed? ?out|unavailable|overloaded/i.test(message)) return 503;
  return Number(error?.status) >= 400 ? Number(error.status) : 400;
}

export default {
  async fetch(request, env) {
    if (!authorised(request, env.JEV_SECRET)) return reply(401, { success: false, errors: [{ message: "unauthorised" }] });
    if (request.method !== "POST") return reply(404, { success: false, errors: [{ message: "POST only" }] });
    let body;
    try {
      body = await request.json();
    } catch {
      return reply(400, { success: false, errors: [{ message: "the body is not JSON" }] });
    }
    try {
      const result = await env.AI.run("typesafe/jev", { state: body.state, questions: body.questions });
      return reply(200, { result, success: true });
    } catch (error) {
      return reply(statusOf(error), { success: false, errors: [{ message: String(error?.message || error).slice(0, 300) }] });
    }
  },
};
