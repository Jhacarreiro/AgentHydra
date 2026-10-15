/**
 * inbox-facts - the true facts an inbox test merges into each Sue's copy of an event-host email.
 * In the product a cold email goes only to someone whose event we found, so her event and where we found it are
 * true of her. A Sue's facts come from her own persona line (`because`), are never shared across Sues, and a
 * persona with no event of her own is left out of an event-host audience, like a cleaned list.
 *
 * The first ten are the event-host roster. The rest were written for the cold-outreach audiences (docs/strategy/
 * COLD_OUTREACH_TEMPLATES.md): each is a Boardroom Sue person whose own persona line says she really uses the platform
 * named in her facts, tagged with the `audience` she belongs to.
 */
import { mergeTokensOf } from "./inbox-test.mjs";

const eventbriteHost = (event_name, because) => ({ audience: "eventbrite", event_name, where_found: "Eventbrite", because });
const facebookGroup = (group_name, because) => ({ audience: "facebook", group_name, where_found: "Facebook", because });
const lumaHost = (calendar_name, event_name, because) => ({ audience: "luma", calendar_name, event_name, because });
const socialHost = (event_name, where_found, because) => ({ audience: "social", event_name, where_found, because });
const cardHost = (event_name, where_found, because) => ({ audience: "card", event_name, where_found, because });
const lemonSeller = (product_name, because) => ({ audience: "lemon", product_name, where_found: "Lemon Squeezy", because });
const nonprofitHost = (event_name, because) => ({ audience: "nonprofit", event_name, where_found: "your website", because });

export const INBOX_FACTS = {
  "brewery-sam": {
    event_name: "Tuesday trivia",
    where_found: "Facebook",
    because: "runs trivia every Tuesday; her events are a Facebook page",
  },
  "band-mateo": {
    event_name: "cumbia band show",
    where_found: "Eventbrite",
    because: "sells tickets for his band's own shows through Eventbrite",
  },
  "bookstore-owen": {
    event_name: "author reading",
    where_found: "Eventbrite",
    because: "hosts an author reading twice a month and uses Eventbrite",
  },
  "comedy-rosa": {
    event_name: "stand-up showcase",
    where_found: "Eventbrite",
    because: "produces a monthly stand-up showcase, tickets through Eventbrite",
  },
  "meetup-raj": { event_name: "monthly tech meetup", where_found: "Meetup.com", because: "runs a monthly tech meetup on Meetup.com" },
  "assoc-gary": {
    event_name: "annual HR conference",
    where_found: "Cvent",
    because: "runs the annual conference of an HR association on Cvent",
  },
  "race-derrick": {
    event_name: "charity 5K",
    where_found: "a race registration site",
    because: "race director of a charity 5K on a race registration site",
  },
  "pottery-mei": {
    event_name: "date-night pottery class",
    where_found: "a class booking app",
    because: "teaches a one-night date-night class booked in a class booking app",
  },
  "yoga-leah": { event_name: "yoga class", where_found: "Mindbody", because: "owns a yoga studio whose classes are booked on Mindbody" },
  "chamber-linda": {
    event_name: "monthly mixer",
    where_found: "the chamber website",
    because: "runs the chamber's monthly mixer (her persona names no listing site; the chamber's own page is not contradicted)",
  },

  // Eventbrite hosts (cold-outreach T01)
  "eb-wine-marisol": eventbriteHost(
    "wine flight night",
    "you run a small tasting room in Sonoma and host a monthly wine flight night for 60 guests at 45 dollars a seat, sold through Eventbrite",
  ),
  "eb-improv-dev": eventbriteHost(
    "Saturday improv show",
    "you own a 90-seat improv theater in Minneapolis and sell tickets to the Saturday improv show at 15 dollars through Eventbrite",
  ),
  "eb-supper-tobias": eventbriteHost(
    "monthly supper club",
    "a chef who runs a monthly supper club in Portland, Maine for 30 guests at 85 dollars each, tickets through Eventbrite",
  ),
  "eb-paint-lacey": eventbriteHost(
    "paint and sip night",
    "you lead a paint and sip night in a Nashville bar for 40 guests at 35 dollars a ticket, sold through Eventbrite",
  ),
  "eb-pasta-giulia": eventbriteHost(
    "pasta-making class",
    "you teach a hands-on pasta-making class in a rented kitchen in Providence, 12 seats at 95 dollars, booked through Eventbrite",
  ),
  "eb-zine-quinn": eventbriteHost(
    "zine and print fair",
    "you organize an annual indie zine and print fair in Oakland that draws about 150 people at 8 dollars a ticket on Eventbrite",
  ),
  "eb-speeddate-andre": eventbriteHost(
    "speed dating night",
    "you run speed dating nights for people over thirty in Atlanta, about 50 people at 28 dollars a ticket sold through Eventbrite",
  ),
  "eb-games-wen": eventbriteHost(
    "game tournament night",
    "you own a board game cafe in Milwaukee and sell 10 dollar entries to a monthly tournament night through Eventbrite",
  ),
  "eb-poetry-imani": eventbriteHost(
    "poetry slam",
    "you host a monthly poetry slam in a Detroit theater with 120 seats at 10 dollars, tickets through Eventbrite",
  ),
  "eb-film-hector": eventbriteHost(
    "rooftop film screening",
    "you run rooftop film screenings in Albuquerque for about 100 people at 14 dollars a ticket, sold through Eventbrite",
  ),
  "eb-auction-bev": eventbriteHost(
    "silent auction night",
    "you volunteer as chair of a hospital auxiliary's silent auction night in Des Moines, 180 guests at 60 dollars a ticket sold through Eventbrite",
  ),
  "eb-bachata-luz": eventbriteHost(
    "bachata social night",
    "you teach and host a Friday bachata social in a rented hall in Orlando for about 90 people at 15 dollars, tickets through Eventbrite",
  ),
  "eb-sourdough-pete": eventbriteHost("sourdough workshop", "you own a neighborhood bakery in St"),
  "eb-pitch-nikhil": eventbriteHost(
    "founder pitch night",
    "you host a founder pitch night in Raleigh for about 80 people at 20 dollars a ticket, sold through Eventbrite",
  ),
  "eb-theatre-susan": eventbriteHost(
    "spring theatre showcase",
    "you direct a youth theatre troupe in Hartford and sell tickets to the spring theatre showcase, 220 seats at 12 dollars, through Eventbrite",
  ),
  "eb-vinyl-clay": eventbriteHost(
    "vinyl swap meet",
    "you run a quarterly vinyl swap meet in Louisville that draws about 200 people at 5 dollars at the door and through Eventbrite",
  ),
  "eb-hike-ana": eventbriteHost(
    "sunrise hike and brunch",
    "you lead a Sunday sunrise hike with brunch afterwards in Boulder for 35 people at 40 dollars each, sold through Eventbrite",
  ),

  // Luma hosts (T05)
  "luma-austin-ai-nora": lumaHost(
    "Austin AI Builders",
    "Demo Night",
    "a machine learning engineer who runs a small AI builders community in Austin",
  ),
  "luma-founders-elliot": lumaHost(
    "Founders Table NYC",
    "founder dinner",
    "you host invite-only founder dinners of fourteen people in Brooklyn",
  ),
  "luma-climate-anjali": lumaHost("Climate Coffee Chicago", "climate coffee meetup", "you organize a climate tech community in Chicago"),
  "luma-design-marco": lumaHost(
    "Designers Who Ship",
    "portfolio review night",
    "a product designer who hosts a design community in Denver",
  ),
  "luma-product-hannah": lumaHost(
    "Product Happy Hour Seattle",
    "product happy hour",
    "a product manager in Seattle who runs a product community",
  ),
  "luma-run-jamal": lumaHost("Sunrise Run Club Portland", "Saturday long run", "you founded a run club in Portland"),
  "luma-books-tess": lumaHost("Page Turners Atlanta", "book club social", "you host a social book club in Atlanta"),
  "luma-makers-oskar": lumaHost("Indie Makers Boston", "show and tell night", "a bootstrapped developer who runs a community in Boston"),
  "luma-breath-sienna": lumaHost("Breathwork Sundays LA", "Sunday breathwork circle", "a breathwork facilitator in Los Angeles"),
  "luma-lang-diego": lumaHost(
    "Idiomas Mixer Houston",
    "language exchange night",
    "a bilingual teacher who hosts a language exchange in Houston",
  ),

  // Partiful and Posh social hosts (T09)
  "social-rooftop-trey": socialHost("rooftop day party", "Posh", "you promote rooftop day parties in Miami"),
  "social-potluck-kelsey": socialHost(
    "Friendsgiving potluck",
    "Partiful",
    "you throw a themed party at your apartment every month for about 40 friends and friends of friends, with a suggested 10 dollars on Venmo, and you send the invites through Partiful",
  ),
  "social-semiformal-darnell": socialHost(
    "spring semi-formal",
    "Posh",
    "a student at a state university and social chair of a campus student organization",
  ),
  "social-warehouse-mika": socialHost(
    "warehouse dance night",
    "Posh",
    "you run a small DJ collective in Brooklyn and sell tickets to a warehouse dance night every other month through Posh, usually 250 people at 20 dollars",
  ),
  "social-dinner-odile": socialHost(
    "dinner party",
    "Partiful",
    "you host a dinner party for sixteen friends and acquaintances in Los Angeles once a month and send the invites through Partiful, with guests chipping in 30 dollars",
  ),
  "social-games-ravi": socialHost("game night", "Partiful", "you host a game night at your place in Chicago for 25 people"),
  "social-karaoke-bea": socialHost(
    "karaoke night",
    "Partiful",
    "you host a monthly karaoke night in the clubhouse of your apartment building for about 40 people and send the invites through Partiful",
  ),
  "social-queer-jules": socialHost(
    "monthly queer dance night",
    "Posh",
    "you run a monthly queer dance night in a rented bar room in Minneapolis, 150 tickets at 15 dollars sold through Posh",
  ),
  "social-swap-wanda": socialHost(
    "clothing swap party",
    "Partiful",
    "you host a clothing swap party for about 50 people in a friend's loft in Kansas City and send the invites through Partiful",
  ),
  "social-popup-felix": socialHost(
    "pop-up art show",
    "Posh",
    "an artist who organizes a pop-up art show in Philadelphia, 120 guests at 15 dollars a ticket through Posh",
  ),

  // Blinq and Popl solo networkers (T13)
  "card-realtor-monica": cardHost("chamber business mixer", "Blinq", "a residential realtor in Scottsdale"),
  "card-advisor-glen": cardHost("small business expo", "Popl", "an independent financial advisor in Omaha"),
  "card-mortgage-tanya": cardHost("realtor appreciation breakfast", "Blinq", "a mortgage broker in Charlotte"),
  "card-it-ibrahim": cardHost("weekly networking breakfast", "Popl", "a solo IT consultant for small offices near Detroit"),
  "card-headshot-celeste": cardHost("creative professionals meetup", "Popl", "a headshot photographer in San Diego"),
  "card-cleaning-rick": cardHost(
    "regional facilities trade show",
    "Blinq",
    "a sales rep for a commercial cleaning company in Indianapolis",
  ),
  "card-coach-yvonne": cardHost("women in business luncheon", "Popl", "a career coach in Baltimore"),
  "card-solar-lars": cardHost("home and garden expo", "Blinq", "a solar sales consultant in Denver"),
  "card-attorney-sana": cardHost("community legal clinic night", "Blinq", "a solo estate planning attorney in Houston"),
  "card-founder-bao": cardHost("startup week mixer", "Popl", "the founder of an early-stage software startup in San Jose"),

  // Lemon Squeezy software sellers (T17)
  "ls-tabsprout": lemonSeller(
    "Tabsprout",
    "a solo developer who sells a Chrome extension called Tabsprout through Lemon Squeezy, a 6 dollar monthly subscription with a few hundred subscribers",
  ),
  "ls-clipwell": lemonSeller(
    "Clipwell",
    "you sell a macOS clipboard manager called Clipwell as a one-time licence key, through Lemon Squeezy",
  ),
  "ls-pagelint": lemonSeller(
    "Pagelint",
    "you run a small SEO audit tool called Pagelint as a monthly subscription, billed through Lemon Squeezy, with a couple of hundred customers",
  ),
  "ls-quillnote": lemonSeller(
    "Quillnote",
    "you sell Quillnote, a paid plugin for a note taking app, as a 29 dollar licence through Lemon Squeezy",
  ),
  "ls-grainlog": lemonSeller(
    "Grainlog",
    "you sell Grainlog, an app that helps photographers cull and rate photos, as a yearly subscription through Lemon Squeezy",
  ),
  "ls-nudgekit": lemonSeller("Nudgekit", "you sell Nudgekit, a paid React component library, as a team licence through Lemon Squeezy"),
  "ls-loopcut": lemonSeller(
    "Loopcut",
    "you built Loopcut, a small app that turns screen recordings into loops, and sell it as a monthly subscription through Lemon Squeezy",
  ),
  "ls-metricbird": lemonSeller(
    "Metricbird",
    "you run Metricbird, a small analytics tool for newsletter writers, as a monthly subscription billed through Lemon Squeezy",
  ),
  "ls-sparrowmail": lemonSeller(
    "Sparrowmail",
    "you sell Sparrowmail, a pack of email templates with a licence key for freelancers, through Lemon Squeezy",
  ),
  "ls-cronwatch": lemonSeller(
    "Cronwatch",
    "you run Cronwatch, a small service that watches scheduled jobs for developers, as a monthly subscription through Lemon Squeezy",
  ),

  // Facebook Groups organisers (T21)
  "fb-trail-heidi": facebookGroup(
    "Asheville Trail Runners",
    "you run a free Facebook group called Asheville Trail Runners with about 1,400 members and organise a group run every week",
  ),
  "fb-parents-noelle": facebookGroup(
    "Eastside Parents Swap",
    "a mom who runs a free Facebook group called Eastside Parents Swap in Columbus, with about 900 members trading kids' clothes and gear",
  ),
  "fb-hikers-gus": facebookGroup(
    "Front Range Weekend Hikers",
    "you run a free Facebook group called Front Range Weekend Hikers with about 1,800 members and lead a hike most Saturdays",
  ),
  "fb-garden-mabel": facebookGroup(
    "Tulsa Backyard Gardeners",
    "you run a free Facebook group called Tulsa Backyard Gardeners with around 650 members and organise a seed swap every spring",
  ),
  "fb-pickle-rhonda": facebookGroup(
    "Mesa Pickleball Players",
    "you run a free Facebook group called Mesa Pickleball Players with about 1,100 members who arrange games at the courts",
  ),
  "fb-homeschool-keiko": facebookGroup(
    "Tri-County Homeschool Co-op",
    "you organise a homeschool co-op in your county and run its free Facebook group Tri-County Homeschool Co-op, which has about 320 families",
  ),
  "fb-biz-armando": facebookGroup(
    "Valley Small Business Owners",
    "you run a free Facebook group called Valley Small Business Owners in the Rio Grande Valley for about 700 local owners to share leads",
  ),
  "fb-knit-dolores": facebookGroup(
    "Saturday Knit and Natter",
    "you run a free Facebook group called Saturday Knit and Natter with about 240 members and a weekly meetup at the library",
  ),
  "fb-mamas-pam": facebookGroup(
    "Mindful Mamas KC",
    "a life coach in Kansas City who runs a free Facebook group called Mindful Mamas KC with about 1,600 members as the front door to her paid programs",
  ),
  "fb-neighbors-wes": facebookGroup(
    "Maple Heights Neighbors",
    "you run a free Facebook group called Maple Heights Neighbors with about 2,000 members who share lost pets, road closures and yard sales",
  ),
  "nonprofit-director-maya": nonprofitHost(
    "annual fundraising breakfast",
    "directs a small community nonprofit and helps run its yearly fundraising breakfast",
  ),
  "pta-carmen": nonprofitHost("spring fundraising gala", "chairs the spring gala for her elementary school PTA"),
  "careful-saver-bob": nonprofitHost("spring pancake breakfast", "helps his lodge run its spring pancake breakfast in the church hall"),
  "board-member-bob": nonprofitHost(
    "annual charity golf outing",
    "is volunteer treasurer of a local nonprofit that runs an annual charity golf outing",
  ),
  "church-pat": nonprofitHost("church potluck supper", "handles the sign-ups for her church's potluck suppers from the church office"),
  "skeptic-dee": nonprofitHost(
    "business networking breakfast",
    "keeps the books for a local business group that holds a monthly networking breakfast",
  ),
  "low-attention": nonprofitHost(
    "hospital auxiliary bake sale",
    "volunteers with her hospital's auxiliary, which runs a holiday bake sale",
  ),
  karen: nonprofitHost("neighborhood yard sale", "helps organize the neighborhood association's yearly yard sale"),
  "nonprofit-denise": nonprofitHost("monthly food drive", "coordinates the volunteers for her church pantry's monthly food drive"),
  "teacher-rivera": nonprofitHost("middle school science fair", "teaches seventh and eighth grade and helps run her school's science fair"),
  "old-sue": nonprofitHost("community center bingo night", "volunteers at the community center, which runs a bingo night"),
  "skeptical-investor-claire": nonprofitHost("charity auction dinner", "gives time to a charity whose yearly auction dinner she helps run"),
};

const SUE_NAME = ["first_name"];

/** The facts a persona has, without the `because` note; `{}` for a persona with no event of her own. */
export function inboxFactsFor(personaId) {
  const { because: _because, audience: _audience, ...facts } = INBOX_FACTS[personaId] ?? {};
  return facts;
}

/** Every `{ persona, token }` the email needs that a persona has no fact for (a Sue's first name is minted for every Sue). */
export function unfilledMerge(email, personaIds) {
  const needed = mergeTokensOf(email).filter((token) => !SUE_NAME.includes(token));
  return personaIds.flatMap((persona) => {
    const facts = inboxFactsFor(persona);
    return needed.filter((token) => !String(facts[token] ?? "").trim()).map((token) => ({ persona, token }));
  });
}

/**
 * `count` personas with a fact for every token of the email, in id order; refuses when there are fewer. Only the
 * untagged event hosts: a persona with an `audience` (a Luma host, a Lemon Squeezy seller) belongs to one cold-outreach
 * audience and is named in the run, never picked by token overlap.
 */
export function eventHostsFor(email, count) {
  const fits = Object.keys(INBOX_FACTS)
    .sort()
    .filter((persona) => !INBOX_FACTS[persona].audience && unfilledMerge(email, [persona]).length === 0);
  if (fits.length < count)
    throw new Error(`only ${fits.length} personas have a true fact for every merge field of this email, not ${count}`);
  return fits.slice(0, count);
}
