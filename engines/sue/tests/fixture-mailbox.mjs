// fixture-mailbox.mjs - the fake mailroom behind the fixture site.
//
// Why it exists: sue/mailroom.mjs polls AWS SES inbound and writes the mail-file contract
// (`<run>/mail/<address>/<id>.json` = { from, subject, text, receivedAt, deliveredAt, messageId })
// out of real inbound mail. Offline tests need the same contract with none of AWS - this module
// is the fixture stand-in: fixture-server.mjs calls `deliver()` when its fake OTP delay elapses
// and this writes exactly the file shape a real Sue's `check_email` tool reads.
//
// Depends on it: sue/tests/fixture-server.mjs (the only caller) and
// sue/tests/e2e-fixture.spec.mjs (reads the files this writes).

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function startFixtureMailbox({ mailDir }) {
  if (!mailDir) {
    throw new Error("startFixtureMailbox requires { mailDir }");
  }

  async function deliver({ to, from, subject, text }) {
    if (!to) {
      throw new Error("fixture-mailbox.deliver requires { to }");
    }
    const deliveredAt = new Date().toISOString();
    const messageId = `fixture-${randomUUID()}`;
    // The fixture mailbox has no separate transport hop to distinguish send-time from
    // receive-time (there is no SES, no S3 object to fetch) - delivery IS receipt here.
    const record = {
      from: from || "Moments <no-reply@moments.fixture>",
      subject: subject || "Your verification code",
      text,
      receivedAt: deliveredAt,
      deliveredAt,
      messageId,
    };

    const dir = path.join(mailDir, to);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${messageId}.json`), JSON.stringify(record, null, 2), "utf8");

    return record;
  }

  return { deliver };
}
