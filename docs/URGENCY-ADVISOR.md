# Urgency Advisor (a background loop)

A local loop in the AgentHydra server (`server/src/urgency-advisor.ts`); never a cloud routine or anything on the
claude.ai account. Default ON. A check runs each minute and does a pass when the interval (default 30 minutes) has passed.

- **Who gets a nudge:** every Desk 2 chat and Hydra Core seat whose status is `working` and whose current turn
  (`turnStartedAt`) is 30+ minutes old. Not idle, stopped, waiting-on-owner (`needs_you`) or CliMayte drone-worker chats.
  At most one nudge per chat per 30 minutes of running; what was sent is kept in `<data dir>/urgency-advisor.json`, so a
  restart does not double-send.
- **What is sent:** exactly `[Urgency Advisor · <Name>] Sent on the owner's behalf.`, a blank line, then one line from the
  persona's `lines` (`{minutes}` and `{title}` filled in). Name and lines come at runtime from
  `people/manager/duke-urgency-advisor/persona.json`; the repo holds only the neutral fallback "Urgency Advisor". No model call.
- **Delivery:** `POST /api/chats/:id/messages` on Desk 2, which pushes the text into the chat's open input stream. The CLI
  takes it at its next tool boundary; the turn is not stopped or relaunched.
- **Setting:** `GET /api/urgency-advisor` and `POST /api/urgency-advisor {enabled?, intervalMinutes?}` (db settings
  `urgency_advisor_enabled`, `urgency_advisor_minutes`; interval 5-720).
- **Log:** one line per nudge in the server log: `[urgency-advisor] chat=<id> minutes=<n> sent=ok|failed`.
