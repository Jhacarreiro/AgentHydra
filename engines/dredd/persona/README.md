# The owner seat - how the "the Chair" board member was built, and how to check or refresh it

> Owner ask (the Chair, 2026-09-25): "for dredd... build a boardroom persona for "the Chair". By reading through every
> chat on this pc and reading all decisions/user responses etc. (That are clearly not AI written) and build a persona
> that is the Chair, including his writing style etc. (Just strip out the profanity and obvious seriously angry
> explicit terms)"

The seat is the Chair's voice at the Boardroom table: its brief is how he judges and how he talks, its playbook is 50
of his standing rules, each with his own words. Jev seats it where the call is his on sight (how a screen looks and
feels, whether a feature is for the mainstream, the AI product, how the agents working for him behave) and leaves it
home on a fact a check or a visitor settles. In a room the Chair asks, his own lines read `the Chair (asking)`.

## How it was built (2026-09-25)

1. **Extract** - `extract.py` read every chat on the PC: 2,384 Claude Code sessions, 221 AgentHydra CLI sessions and
   2,012 Codex sessions, 13,440 distinct messages from February to September 2026 once hook text, tool results,
   notifications, peer messages and headless runs were dropped.
2. **Who wrote it** - the plainly typed ones passed on the heuristic (117 of 120 audited were his); the rest went to
   the zswarm, one tool-free call per batch, labelling each message his, AI-written, pasted, mixed (his words kept) or
   a system notice. 12,524 messages stayed, 2.98M characters.
3. **Mine** - about 250 zswarm batches pulled his rulings, likes, dislikes, voice habits and sample lines, every
   quote copied exactly; a script dropped any quote not found in the message it named (94% survived).
4. **Merge** - two zswarm passes merged about 7,300 grounded rows into 652 rules across 14 topics, strongest first,
   each quote grounded again.
5. **Write** - the brief and the 50 entries were written from those rules by the orchestrating Opus session; every
   quote was checked word for word against his messages, with swearing stripped and insults left out entirely.

## What it measured

A held-out test: 67 real decisions of his that the seat never quoted were turned into neutral situations. The seat
and a generic "owner of a small software company" answered each on the same model (the seat with its brief plus the
five playbook entries the Boardroom's own retrieval would hand it), and a judge from another model family graded
every answer blind against what he actually decided.

| arm (51 paired situations) | same call | partly | different | score | sounds like him (1-5) |
| -------------------------- | --------- | ------ | --------- | ----- | --------------------- |
| generic owner              | 25        | 6      | 20        | 0.55  | 2.9                   |
| the the Chair seat           | 34        | 6      | 11        | 0.73  | 3.7                   |

It is strongest on how things look (0.80 against 0.61) and how agents should work (0.80 against 0.55); on one-off
product specifics (a hosting move, a legal entity) it has nothing to go on, as it should not. The seat pick, over
the gold briefs in `eval/seats.json`: Jev seats it on 9 of the 10 briefs where it belongs, 98% must-sit overall; the
A/B against the code before it was NEUTRAL.

## Checking and refreshing it

The seat's words live in Connections, never in the repo (Owner, 2026-09-28): the board member "the Chair" in the
Connections workspace holds the brief and the 50 entries, and `seats/13-chair.json` holds only where he sits (his
Jev question and keywords). Read him whole with `boardroom_personas_get { id }` (the id is on
`boardroom_personas_list { compact: true }`), save that answer's `persona` as `tmp/dredd/persona/chair.json`, then:

```
python dredd/persona/extract.py
python dredd/persona/verify_seat.py tmp/dredd/persona/chair.json
```

`verify_seat.py` fails on any quote that is not in a message he typed, any swearing, any em dash and any field past
the plane's limits; run it after every edit to the seat, and write the checked brief and playbook back with
`boardroom_personas_update { id, brief, playbook }`. Both need this PC's chats, and the extracted text stays
under `tmp/` (never committed). The seat file is a decision file, so an edit to its Jev question or keywords also
owes `node dredd/eval.mjs --seats-only` and `node dredd/ab.mjs --record`
([dredd-self-improvement.md](../../../.claude/rules/dredd-self-improvement.md)).

To refresh after months of new chats: run `extract.py`, send the `review` band to HSwarm to label who wrote it,
mine the messages newer than 2026-09-25 for rulings with exact quotes, and fold anything new or changed into the
seat's entries by hand, then `verify_seat.py`, then `boardroom_personas_update`.
