"""Checks an owner seat against the person's own messages: every quote in the playbook's "In his words:" lines must be
in a message he really typed (after the same profanity cleaning the seat used), and the seat must carry no swearing,
no em or en dash, and fit the Boardroom plane's field limits. Run it after any edit to the seat.

    python dredd/persona/extract.py                         once, to build tmp/dredd/persona/messages.jsonl
    python dredd/persona/verify_seat.py [tmp/dredd/persona/chair.json]

The seat's words live in Connections (Owner, 2026-09-28): save boardroom_personas_get's `persona` for the "the Chair"
board member to that file first, and write the checked text back with boardroom_personas_update.

Exit 1 names every quote that is not his and every rule the seat breaks. It needs the extracted messages, so it runs
on the machine whose chats built the seat.
"""
import json, os, re, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
SEAT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "tmp", "dredd", "persona", "chair.json")
MESSAGES = os.path.join(ROOT, "tmp", "dredd", "persona", "messages.jsonl")
# The plane's persona limits (services/boardroom/lambda/src/_shared/input-bounds.ts TEXT_LIMITS).
LIMITS = {"name": 60, "modeledOn": 120, "seatTitle": 120, "oneLiner": 400, "brief": 60000, "playbook": 400000}

# the Chair's ask: "strip out the profanity and obvious seriously angry explicit terms". Oaths and intensifiers are
# deleted, a few phrases get the plain word he would use in front of a client; a line with an insult is not used.
PHRASES = [(re.compile(p, re.I), r) for p, r in [
    (r"\bwhat the (fuck|hell|heck|f)\b", "what"), (r"\bthe (fuck|hell)\b ?", ""), (r"\bfuck(ed|ing)? up\b", "messed up"),
    (r"\bfuck(ing|in')? (ton|load)s?\b", "ton"), (r"\bholy (shit|crap|fuck)\b", "wow"), (r"\bbull ?shit\b", "nonsense"),
    (r"\b(a )?(piece of )?shit\b", "junk"), (r"\bshitty\b", "bad"), (r"\bpissed( off)?\b", "annoyed"),
    (r"\bgod ?damn(ed|it)?\b ?", ""), (r"\bdamn(ed|it)?\b ?", ""),
    (r"\bfreaking\b ?|\bfrickin'?\b ?|\bfucking\b ?|\bfuckin'?\b ?|\bf\*+ing\b ?", ""), (r"\bfuck\w*\b ?", ""),
    (r"\bass(es)?\b ?", ""), (r"\bwtf\b", "what"), (r"\bjesus( christ)?\b,? ?", ""), (r"\bcrap(py)?\b", "junk"),
]]
SWEARING = re.compile(r"\b(fuck\w*|shit\w*|damn\w*|goddamn\w*|bitch\w*|bastard|asshole|wtf|retard\w*|cunt|dumbass|crap)\b", re.I)


def clean(text):
    s = text
    for r, rep in PHRASES:
        s = r.sub(rep, s)
    s = re.sub(r"\s{2,}", " ", s)
    return re.sub(r"\s+([,.!?])", r"\1", s).strip()


def norm(s):
    s = s.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    return re.sub(r"\s+", " ", s).strip().lower()


def quotes(playbook):
    """Every quoted line of every "In his words:" line: "..." (YYYY-MM), separated by " · "."""
    for line in playbook.splitlines():
        if line.startswith("In his words: "):
            for q in re.findall(r"\"(.*?)\" \(\d{4}-\d{2}\)(?: · |$)", line[len("In his words: "):]):
                yield q


def main():
    seat = json.load(open(SEAT, encoding="utf-8"))
    problems = []
    for k, cap in LIMITS.items():
        if len(seat.get(k) or "") > cap:
            problems.append(f"{k} is {len(seat[k])} characters, the plane takes {cap}")
    text = " ".join(str(seat.get(k) or "") for k in ("name", "seatTitle", "oneLiner", "brief", "playbook", "jev"))
    if "—" in text or "–" in text:
        problems.append("an em or en dash (his rule: none anywhere)")
    for m in set(SWEARING.findall(text)):
        problems.append(f"swearing left in the seat: {m}")
    if not os.path.exists(MESSAGES):
        sys.exit(f"no {MESSAGES}: run dredd/persona/extract.py on the machine whose chats built the seat")
    said = [norm(clean(json.loads(line)["text"])) for line in open(MESSAGES, encoding="utf-8")]
    qs = list(quotes(seat.get("playbook") or ""))
    for q in qs:
        n = norm(q).strip(" .\"'")
        if not any(n in m for m in said):
            problems.append(f"not in any message he typed: {q[:100]}")
    entries = len(re.findall(r"^## ", seat.get("playbook") or "", re.M))
    if problems:
        print("\n".join(problems))
        sys.exit(1)
    print(f"ok: {entries} playbook entries, {len(qs)} quotes, every one in his own messages ({len(said)} searched)")


if __name__ == "__main__":
    main()
