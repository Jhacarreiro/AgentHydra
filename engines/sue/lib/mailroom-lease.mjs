/**
 * mailroom-lease - the vault lease a wave's mailroom reads Sue mail with, taken by the engine itself.
 * ====================================================================================================
 *
 * WHAT: `mintMailroomLease(mcp)` asks the Connections vault for a one-hour AWS session on the `Root/Connections`
 * account and answers `{ env, instance, expiresAt }` (the AWS_* variables a child process reads) or `{ error }`.
 * `needsMailroomLease(env)` says whether this process has no credentials of its own: no named profile
 * (AWS_PROFILE) and no keys (AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY).
 *
 * WHY: the Connections MCP's sue door took this lease before every wave and ran the engine on it
 * (services/studio/local-mcp/src-impl/26b-tools-sue.mjs, `mintVaultCredEnv("Root/Connections")`), so Sues that make
 * accounts could read their mail on a machine with no SSO login. AgentHydra now starts the engine directly
 * (`node sue/sue.mjs run`, 2026-10-15) and no door leases anything, so a wave with no credentials ran on the
 * "main" profile and was refused wherever that profile is not signed in.
 *
 * HOW: the same vault, the same way: one `connections_execute { service: "aws", tool_name: "aws_call", instance }`
 * carrying an STS GetSessionToken, through the local MCP this process already opened for its people
 * (lib/people.mjs openPeopleDoor, dredd/lib/mcp.mjs `execute`), on this machine's signed-in account. Nothing of
 * Connections is imported. Value-blind: the keys go into the returned env and nowhere else; no error quotes the
 * answer's body. The door also probed an IAM-capable operator role; the mailroom reads mail and S3, so the
 * session mint every account takes is enough.
 *
 * DEPENDED ON BY: sue.mjs (`doorDuties`, before a wave is planned; the lease goes to the wave's runner only, never into
 * the env of the process that took it). Spec: tests/door-duties.spec.mjs.
 */
export const MAILROOM_INSTANCE = "Root/Connections";

const STS_SESSION = "Action=GetSessionToken&Version=2011-06-15&DurationSeconds=3600";
// A credential that is not credential-shaped (the literal "[redacted]", an error page) is no credential.
const ACCESS_KEY_RE = /^[A-Z0-9]{16,}$/;
const SECRET_KEY_RE = /^[A-Za-z0-9/+=]{30,}$/;

/** Whether this process has neither a named profile nor keys of its own. */
export function needsMailroomLease(env = process.env) {
  return !env.AWS_PROFILE && !(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY);
}

/** The session in an STS answer's XML, shape-checked, or null. */
export function stsSession(xml) {
  const grab = (re) => (String(xml || "").match(re) || [])[1];
  const accessKeyId = grab(/<AccessKeyId>([^<]+)<\/AccessKeyId>/);
  const secretAccessKey = grab(/<SecretAccessKey>([^<]+)<\/SecretAccessKey>/);
  if (!ACCESS_KEY_RE.test(accessKeyId ?? "") || !SECRET_KEY_RE.test(secretAccessKey ?? "")) return null;
  return {
    accessKeyId,
    secretAccessKey,
    sessionToken: grab(/<SessionToken>([^<]+)<\/SessionToken>/) || null,
    expiresAt: Date.parse(grab(/<Expiration>([^<]+)<\/Expiration>/)) || Date.now() + 3600_000,
  };
}

/** Lease `instance` through `mcp` (an open local MCP with `execute`). Never throws: `{ env, instance, expiresAt }` or `{ error }`. */
export async function mintMailroomLease(mcp, { instance = MAILROOM_INSTANCE, ms = 60_000 } = {}) {
  if (typeof mcp?.execute !== "function") return { error: "no local MCP was open to reach the vault through" };
  const res = await mcp.execute(
    {
      service: "aws",
      tool_name: "aws_call",
      instance,
      params: {
        service: "sts",
        region: "us-east-1",
        method: "POST",
        path: "/",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: STS_SESSION,
      },
    },
    ms,
  );
  let outer = null;
  try {
    outer = JSON.parse(String(res?.text ?? ""));
  } catch {
    // Not JSON: a refusal in prose (out of credits, signed out, not connected), quoted. Anything credential-shaped
    // (an answer cut mid-way) is never quoted.
    const text = String(res?.text || "no answer");
    const said = /AccessKeyId|SecretAccessKey|SessionToken|Credentials/i.test(text) ? "an answer that could not be read" : text.slice(0, 240);
    return { error: `the vault did not lease "${instance}": ${said}` };
  }
  const session = stsSession(typeof outer?.body === "string" ? outer.body : "");
  if (!session) {
    const why = [`STS status ${Number(outer?.status) || 0}`, typeof outer?.error === "string" ? outer.error.slice(0, 200) : null];
    return { error: `the vault did not lease "${instance}" (${why.filter(Boolean).join(", ")})` };
  }
  const env = {
    AWS_ACCESS_KEY_ID: session.accessKeyId,
    AWS_SECRET_ACCESS_KEY: session.secretAccessKey,
    AWS_REGION: "us-east-1",
    AWS_DEFAULT_REGION: "us-east-1",
    AWS_CREDENTIAL_EXPIRATION: new Date(session.expiresAt).toISOString(),
  };
  if (session.sessionToken) env.AWS_SESSION_TOKEN = session.sessionToken;
  return { env, instance, expiresAt: session.expiresAt };
}
