/**
 * people - the made-up people SUE's own specs run with.
 * ======================================================
 *
 * SUE's real people live in Connections and nowhere else (lib/people.mjs; Owner, 2026-09-28: "There should not be
 * a single local personality in the workspace"). A spec runs without a network, so it sends TEST people: the built-in
 * ids the engine names (DEFAULT_ROSTER_MIX, the reaper's dev-dan), each with a body (dials and name ranges, the
 * numbers the body and clock read) and a one-line made-up voice. Importing this file installs them;
 * `installTestPeople(extra)` puts a spec's own people (a workspace's, a critic) beside them.
 */
import fs from "node:fs";
import path from "node:path";

import { installPeople } from "../../lib/personas.mjs";

function makeDials(
  readingGrade,
  wordsPerLook,
  wordsPerMinute,
  legibleMinPx,
  techProwess,
  attentionSeconds,
  patienceSeconds,
  temperature,
  device,
  maxTurns,
  extra = {},
) {
  return {
    readingGrade,
    wordsPerLook,
    wordsPerMinute,
    legibleMinPx,
    techProwess,
    attentionSeconds,
    patienceSeconds,
    temperature,
    device,
    maxTurns,
    ...extra,
  };
}

const BODIES = [
  {
    id: "bob",
    dials: makeDials(10, 150, 200, 13, 3, 45, 300, 0.5, "desktop", 50),
    identity: { firstNames: ["Bob", "Robert", "Dale"], lastNames: ["Hendricks", "Sullivan", "Moore"], birthYear: [1973, 1974] },
  },
  {
    id: "casual-cassie",
    dials: makeDials(8, 15, 220, 13, 3, 10, 150, 0.5, "phone", 60),
    identity: { firstNames: ["Cassie", "Jenna", "Amber"], lastNames: ["Morales", "Whitfield", "Kowalski"], birthYear: [1990, 1993] },
  },
  {
    id: "child",
    dials: makeDials(3, 60, 130, 12, 3, 20, 120, 0.4, "phone", 30, { network: "4g" }),
    identity: { firstNames: ["Sue", "Lily", "Ava"], lastNames: ["Brooks", "Patel", "Murphy"], birthYear: [2014, 2015] },
  },
  {
    id: "dev-dan",
    dials: makeDials(14, 0, 300, 10, 5, 60, 300, 0.4, "desktop", 60),
    identity: { firstNames: ["Dan", "Daniel", "Marcus"], lastNames: ["Okafor", "Lindqvist", "Rivera"], birthYear: [1996, 1997] },
  },
  {
    id: "elaine",
    dials: makeDials(12, 120, 280, 12, 4, 30, 240, 0.7, "desktop", 45),
    identity: { firstNames: ["Elaine", "Rebecca", "Karen"], lastNames: ["Whitfield", "Chen", "Lawson"], birthYear: [1984, 1985] },
  },
  {
    id: "esl-maria",
    dials: makeDials(5, 0, 110, 13, 3, 60, 300, 0.3, "desktop", 50),
    identity: { firstNames: ["Maria", "Luisa", "Carolina"], lastNames: ["Gomez", "Restrepo", "Alvarez"], birthYear: [1989, 1990] },
  },
  {
    id: "grandma",
    dials: makeDials(8, 0, 150, 15, 1, 90, 420, 0.2, "desktop", 60, { timezone: "America/New_York" }),
    identity: { firstNames: ["Sue", "Margaret", "Linda"], lastNames: ["Parker", "Hill", "Novak"], birthYear: [1948, 1956] },
  },
  {
    id: "johnny-jun",
    dials: makeDials(12, 0, 280, 11, 4, 40, 720, 0.7, "desktop", 100),
    identity: { firstNames: ["Jun", "Theo", "Mateo"], lastNames: ["Tanaka", "Okonkwo", "Ferreira"], birthYear: [1995, 1998] },
  },
  {
    id: "karen",
    dials: makeDials(9, 100, 180, 14, 2, 30, 90, 0.9, "desktop", 30),
    identity: { firstNames: ["Karen", "Deborah", "Sharon"], lastNames: ["Mitchell", "Bauer", "Griffin"], birthYear: [1967, 1968] },
  },
  {
    id: "kid-kai",
    dials: makeDials(3, 8, 80, 16, 3, 6, 240, 0.7, "phone", 70),
    identity: { firstNames: ["Kai", "Mia", "Leo"], lastNames: ["Bennett", "Ortiz", "Chen"], birthYear: [2016, 2017] },
  },
  {
    id: "lapsed-lou",
    dials: makeDials(12, 30, 240, 13, 3, 25, 600, 0.4, "desktop", 80),
    identity: { firstNames: ["Lou", "Louise", "Dana"], lastNames: ["Hartley", "Moreno", "Fischer"], birthYear: [1981, 1983] },
  },
  {
    id: "low-attention",
    dials: makeDials(9, 80, 250, 12, 3, 15, 150, 0.5, "desktop", 35),
    identity: { firstNames: ["Sue", "Jessica", "Amber"], lastNames: ["Walsh", "Kim", "Foster"], birthYear: [1991, 1992] },
  },
  {
    id: "office-manager",
    dials: makeDials(12, 220, 250, 12, 5, 70, 420, 0.4, "desktop", 55),
    identity: { firstNames: ["Priya", "Anita", "Reena"], lastNames: ["Raman", "Shah", "Nair"], birthYear: [1987, 1988] },
  },
  {
    id: "old-sue",
    dials: makeDials(6, 0, 120, 18, 1, 120, 600, 0.2, "phone", 60, { network: "4g", timezone: "America/New_York" }),
    identity: { firstNames: ["Sue", "Dorothy", "Beverly"], lastNames: ["Kowalski", "Reyes", "Thompson"], birthYear: [1942, 1946] },
  },
  {
    id: "reddit-troll",
    dials: makeDials(10, 60, 320, 11, 5, 12, 120, 0.8, "desktop", 30),
    identity: { firstNames: ["Kyle", "Tyler", "Brandon"], lastNames: ["Hart", "Novak", "Pruitt"], birthYear: [1996, 1998] },
  },
  {
    id: "shop-owner",
    dials: makeDials(11, 180, 240, 13, 4, 55, 330, 0.55, "phone", 50),
    identity: { firstNames: ["Dana", "Marie", "Kelsey"], lastNames: ["Okafor", "Brennan", "Sandoval"], birthYear: [1990, 1991] },
  },
  {
    id: "solo-consultant",
    dials: makeDials(14, 200, 280, 12, 5, 50, 300, 0.5, "desktop", 50),
    identity: { firstNames: ["Marcus", "Alan", "Devin"], lastNames: ["Whitfield", "Barrow", "Kean"], birthYear: [1981, 1982] },
  },
  {
    id: "spike-sam",
    dials: makeDials(11, 0, 350, 10, 5, 30, 900, 0.4, "desktop", 120),
    identity: { firstNames: ["Sam", "Jordan", "Riley"], lastNames: ["Castellano", "Brooks", "Ivanov"], birthYear: [2000, 2003] },
  },
  {
    id: "tiktok",
    dials: makeDials(9, 40, 300, 11, 4, 8, 60, 0.6, "phone", 25, { network: "4g" }),
    identity: { firstNames: ["Sue", "Maya", "Zoe"], lastNames: ["Nguyen", "Carter", "Diaz"], birthYear: [2006, 2007] },
  },
  {
    id: "timmy-tess",
    dials: makeDials(9, 25, 250, 12, 3, 20, 420, 0.6, "desktop", 80),
    identity: { firstNames: ["Tess", "Nina", "Brooke"], lastNames: ["Adeyemi", "Larsen", "Quinn"], birthYear: [1997, 2000] },
  },
  {
    id: "veteran-vic",
    dials: makeDials(12, 0, 320, 10, 5, 45, 900, 0.4, "desktop", 120),
    identity: { firstNames: ["Vic", "Victor", "Andre"], lastNames: ["Hollis", "Park", "Brennan"], birthYear: [1993, 1996] },
  },
];

export const TEST_PEOPLE = BODIES.map(({ id, dials, identity }) => ({
  builtIn: true,
  doc: {
    id,
    displayName: `Test ${id}`,
    voice: `You are ${identity.firstNames[0]}, a made-up visitor in SUE's own specs. You read what is in front of you and click what looks right.`,
    errands: [
      "You came to see whether the page does what it says, and to finish what you started.",
      "You were told this could save you an afternoon, and you want to see that for yourself before you believe it.",
    ],
    dials,
    identity,
  },
}));

/** Install the test people, with `extra` (`{ doc }` each, a workspace's own) beside them and `minds` for its critics. */
export function installTestPeople(extra = [], { minds = {} } = {}) {
  installPeople([...extra, ...TEST_PEOPLE], { minds });
}

/**
 * The test people as a file in `dir`, for a cannon a spec spawns (`--people <file>`) or a sue CLI's args (`people`,
 * `minds`), so no spec ever reaches Connections: a process with no people handed over fetches them live.
 */
export function testPeopleFile(dir, extra = [], { minds = {} } = {}) {
  const file = path.join(dir, "test-people.json");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ people: [...extra, ...TEST_PEOPLE], minds }));
  return file;
}

installTestPeople();
