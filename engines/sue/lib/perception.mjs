/**
 * perception - what a page IS (the DOM inventory) and what SHE SEES (the persona's rendering).
 * ================================================================================================
 * WHY THIS EXISTS: SPEC.md's owner ask is that a persona's numbers "change something mechanical" -
 * TikTok Sue does not skim because we told her to, she skims because `perceive()` cuts her off at
 * `wordsPerLook` words; Grandma Sue does not "miss the icon button" because we asked her to act old,
 * `perceive()` literally renders it to her as `[a small picture button with no words]`. This file
 * is the one place that mechanism lives, in two halves:
 *
 *   INVENTORY_SCRIPT - the source of a zero-arg arrow function, run with `page.evaluate(INVENTORY_SCRIPT)`
 *   (Playwright auto-invokes a string that evaluates to a function). It walks the LIVE page once, in
 *   document order, and returns the raw facts: every visible text block, every interactive element
 *   (role, name, whether it is icon-only, font size, above-the-fold, hidden, autocomplete, label),
 *   every shown picture of 80 by 80 px or more (a loaded <img>, svg, canvas, video or a LOADED url() background
 *   as painted - its drawn size under background-size, a repeating one being the whole box -; not on a control
 *   or a numbered choice card) as a wordless `picture` block with its `top` and `bottom` - never its alt text,
 *   which a sighted visitor does not see -,
 *   any dialog/menu/banner overlay, and any CAPTCHA iframe. It stamps every block and element it
 *   finds with a stable `data-sue-id` attribute (`sue-<n>`, kept on the element from run to run so a
 *   later `click`/`type` call in body.mjs always names the same element), and tags each with that
 *   run's document-order rank (`order`) so `perceive` can still merge the two arrays in order.
 *   The walk enters a web component's OPEN shadow root and a SAME-ORIGIN iframe where they sit, so
 *   their words and controls are read, stamped and numbered like any other (a frame's boxes moved
 *   to where the frame sits on her screen); a closed shadow root, a cross-origin frame and a robot
 *   check stay shut, as they are to a script on the page.
 *
 *   perceive(inventory, persona) - takes that inventory and a persona's `dials` and renders her
 *   actual view: `readingGrade` swaps an over-her-head block for its first sentence plus a tag,
 *   `wordsPerLook` cuts her off mid-page, `legibleMinPx` blinds her to tiny print, `techProwess`
 *   decides how an icon-only control reads - `[a small picture button with no words]` /
 *   `[three little lines]` at 1-2, `[an icon button]` above that, never a name at any level - and
 *   at 4-5 additionally surfaces the URL bar (an `[address bar]` line she does not get below that). Elements marked `hidden` by the inventory
 *   (an off-screen honeypot, a display:none trap) are dropped entirely before rendering - she
 *   never perceives what a real visitor never would, per SPEC.md's "the brain NEVER sees our
 *   code" boundary. Elements are numbered `[1]..[n]` in the order she encounters them among the
 *   ones she can actually see; `clickable` maps that number back to the element's `data-sue-id`
 *   for body.mjs's `click`. A picture block renders as `[a picture]` where it sits: it costs no words
 *   and, like a control, stays in her view after her words run out while it is on her screen.
 *
 * DEPENDS ON: lib/readability.mjs's `fleschKincaidGrade` (the `readingGrade` dial's yardstick), and
 * lib/rails.mjs's `CAPTCHA_FRAME` - the one CAPTCHA-frame pattern the inventory and the pointer share,
 * so neither can drift from the other.
 * DEPENDED ON BY: body.mjs's `look` tool (screenshot + this text). tests/perception.spec.mjs is
 * this file's own spec, against the three committed fixtures in tests/fixtures/pages/.
 */
import { CAPTCHA_FRAME } from "./rails.mjs";
import { isGradeable, readingGradeOf } from "./readability.mjs";

/**
 * Source of a zero-arg, immediately-invoked arrow function - handed to `page.evaluate()` as a
 * STRING on purpose, so this file never needs a bundler step to ship DOM-walking code into the
 * page. It is self-invoking (`(() => { ... })()`) rather than a bare function literal because
 * Playwright's string-form `evaluate()` returns the expression's completion value as-is - a bare
 * `() => {...}` literal completes to the function itself, never calls it; measured directly
 * against playwright-core 1.62 before picking this shape. Keep the body fully self-contained: it
 * runs in the page's own JS realm, with no access to this module's scope.
 */
export const INVENTORY_SCRIPT = `(() => {
  // A page's own widgets count as much as its native ones: a search box's [role=option] results, a
  // menu's items, tabs and switches were never numbered, so a Sue had to point at raw pixels to open
  // "Access tokens" from Example App Next's settings search (run 20260922-063426-626a).
  const ARIA_WIDGET_ROLES = ["option", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "switch", "checkbox", "radio", "link"];
  // A chat app's message box is an editable block, not a <textarea>: Discord's composer is a
  // [role=textbox][contenteditable], and three Sues in a row typed into it a key at a time because it
  // was never numbered (run 20260922-095549-6f32).
  const TEXT_BOX_SELECTOR = "[contenteditable]:not([contenteditable=false]),[role=textbox]";
  // A <details> row opens on a click like a button, with no role attribute to match: three Sues on the
  // ZergSwarm site could not open its FAQ by number or name and had to aim at the words (run 20260926-173610-b6a0).
  const INTERACTIVE_SELECTOR =
    "button,a[href],input,select,textarea,[role=button],details>summary," +
    TEXT_BOX_SELECTOR +
    "," +
    ARIA_WIDGET_ROLES.map((r) => "[role=" + r + "]").join(",");
  const COMBINED_SELECTOR = "h1,h2,h3,h4,h5,h6,p,label,li,dt,dd,blockquote,pre,td,th,caption,figcaption," + INTERACTIVE_SELECTOR;
  // THE SIZE ON THE GLASS, NOT THE STYLESHEET'S. A game shrinks its whole HUD layer with a CSS transform
  // (Nexas Code's phone HUD at scale 0.8-0.86), and a computed font-size is the size before it: every label
  // read 13px while it drew near 11, and 21 phone waves were never told a word was too small (2026-09-26).
  const glassPx = (el, style, rect) => {
    const px = Number.parseFloat(style.fontSize) || 0;
    const scale = el.offsetHeight > 0 && rect.height > 0 ? rect.height / el.offsetHeight : 1;
    return Math.round(px * (scale > 0.2 && scale < 5 ? scale : 1));
  };
  // A BLOCK IS AS BIG AS THE WORDS IT SHOWS, NOT AS THE BOX ROUND THEM. A label drawn at 16px scaled 0.75 round
  // a 17.5px span is 13px on the glass, but the box said 12 and a legible label was called tiny print
  // (2026-10-12, run 20261012-050816-37a2). So each visible text node is sized by its own parent, as glassPx
  // sizes it, weighted by its characters; the size that carries the most characters wins, a tie taking the
  // smaller. An inline parent has no box of its own (offsetHeight 0), so its scale is the nearest box's.
  const wordsPx = (el) => {
    const carried = new Map();
    const visit = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 1) visit(child);
        else if (child.nodeType === 3 && child.parentElement && child.nodeValue.trim()) {
          const parent = child.parentElement;
          const style = styleOf(parent);
          const rect = parent.getBoundingClientRect();
          if (!isVisible(parent, rect, style)) continue;
          let box = parent;
          while (box !== el && box.offsetHeight === 0) box = box.parentElement;
          const px = glassPx(box, style, box === parent ? rect : box.getBoundingClientRect());
          carried.set(px, (carried.get(px) || 0) + child.nodeValue.trim().length);
        }
      }
    };
    visit(el);
    let best = 0;
    let bestChars = -1;
    carried.forEach((chars, px) => {
      if (chars > bestChars || (chars === bestChars && px < best)) {
        best = px;
        bestChars = chars;
      }
    });
    return best || glassPx(el, styleOf(el), el.getBoundingClientRect());
  };
  // A native box keeps its own role whatever it says: the body's typing and card-box rails read it.
  const NOT_TEXT_INPUTS = ["checkbox", "radio", "button", "submit", "reset", "image"];
  // Table cells, code blocks and captions were never read, so a comparison table or a code sample
  // was invisible: a developer Sue called a documented webhook payload "missing or empty". A cell
  // that holds its own paragraph or list is read through those instead, never twice. So is a cell
  // that holds another cell: an email is tables inside tables, so its footer cell and the cell inside
  // it carry the same words, and a Sue read the sign-up code email's one footer tagline twice and
  // filed it as "printed twice" (run 20260926-121640-3a2f, office-manager). Across the 13 different
  // emails Sues received in runs from 2026-09-22 to 2026-09-26, 41 blocks were read twice this way
  // and no words are lost without them.
  const CONTAINER_TAGS = new Set(["pre", "td", "th", "caption", "figcaption"]);
  const NESTED_READABLE = "h1,h2,h3,h4,h5,h6,p,label,li,dt,dd,blockquote,pre,td,th,caption,figcaption";
  const ICON_FONT = /material.(symbols|icons)/i;

  // ⛔ WHAT A SIGHTED PERSON SEES INSIDE A WEB COMPONENT OR A FRAME IS ON HER SCREEN TOO. A page's
  // querySelectorAll and TreeWalker never enter a shadow root or an iframe, so a form inside a web
  // component or a same-origin frame got no words and no numbers, and she could only point at its
  // pixels. The walk below enters every OPEN shadow root (right after its host) and every
  // SAME-ORIGIN iframe (where the frame sits in the page). A closed shadow root and a cross-origin
  // frame stay shut, as they are to the page's own scripts; a robot-check frame is never entered.
  const CAPTCHA_SRC = /${CAPTCHA_FRAME.source}/i;
  const frameDoc = (frame) => {
    if (CAPTCHA_SRC.test(frame.getAttribute("src") || "")) return null;
    try {
      const doc = frame.contentDocument;
      return doc && doc.body ? doc : null;
    } catch (e) {
      return null;
    }
  };
  /** The element above this node, out through a shadow root to its host (never out of a frame). */
  const parentOf = (node) => node.parentElement || (node.parentNode && node.parentNode.nodeType === 11 ? node.parentNode.host || null : null);
  /** closest(), out through every shadow root to its host. */
  const deepClosest = (el, selector) => {
    for (let node = el; node; ) {
      const hit = node.closest(selector);
      if (hit) return hit;
      const root = node.getRootNode();
      node = root.nodeType === 11 && root.host ? root.host : null;
    }
    return null;
  };
  /** contains(), into shadow roots: is inner outer itself or anywhere inside it? */
  const deepContains = (outer, inner) => {
    for (let node = inner; node; node = node.parentNode || (node.nodeType === 11 ? node.host : null)) if (node === outer) return true;
    return false;
  };
  /** Every node from start on, in the order she meets them: a host's shadow tree, then a frame's page, then its own children. */
  function deepWalk(start, intoFrames, visit) {
    const stack = [start];
    while (stack.length) {
      const node = stack.pop();
      visit(node);
      if (node.nodeType !== 1 || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(node.tagName)) continue;
      for (let child = node.lastChild; child; child = child.previousSibling) stack.push(child);
      if (intoFrames && node.tagName === "IFRAME") {
        const doc = frameDoc(node);
        if (doc) stack.push(doc.body);
      }
      if (node.shadowRoot) for (let child = node.shadowRoot.lastChild; child; child = child.previousSibling) stack.push(child);
    }
  }
  const deepElements = [];
  const deepTexts = [];
  deepWalk(document.body || document.documentElement, true, (node) => {
    if (node.nodeType === 1) deepElements.push(node);
    else if (node.nodeType === 3) deepTexts.push(node);
  });
  /** The window an element lives in (a frame's own), for its styles and its size. */
  const winOf = (el) => (el.ownerDocument && el.ownerDocument.defaultView) || window;
  const styleOf = (el) => winOf(el).getComputedStyle(el);
  /** Where a frame's inside starts on her screen, frames inside frames added up. */
  const frameShift = new Map();
  function shiftOf(doc) {
    if (doc === document) return { x: 0, y: 0 };
    if (frameShift.has(doc)) return frameShift.get(doc);
    const frame = doc.defaultView && doc.defaultView.frameElement;
    let shift = { x: 0, y: 0 };
    if (frame) {
      const outer = shiftOf(frame.ownerDocument);
      const box = frame.getBoundingClientRect();
      const style = styleOf(frame);
      shift = {
        // arkitect-allow: css-logical-direction-properties - screen geometry: box.left is physical, so the frame's left padding must be too (inline-start is the right side in RTL)
        x: outer.x + box.left + frame.clientLeft + (Number.parseFloat(style.paddingLeft) || 0),
        y: outer.y + box.top + frame.clientTop + (Number.parseFloat(style.paddingTop) || 0),
      };
    }
    frameShift.set(doc, shift);
    return shift;
  }
  /** A box measured inside a frame, moved to where it sits on her screen. */
  function onScreen(el, rect) {
    const shift = shiftOf(el.ownerDocument);
    if (!shift.x && !shift.y) return rect;
    return {
      x: rect.x + shift.x,
      y: rect.y + shift.y,
      left: rect.left + shift.x,
      top: rect.top + shift.y,
      right: rect.right + shift.x,
      bottom: rect.bottom + shift.y,
      width: rect.width,
      height: rect.height,
    };
  }

  // Does pressing this send its form somewhere other than a search? Same reading as lib/rails.mjs
  // keyPressTargets' sendsForm: a search form only fetches results, anything else reaches a person.
  function sendsItsForm(el, tag, inputType) {
    const form = el.form;
    if (!form) return false;
    const presses = tag === "button" ? (el.getAttribute("type") || "submit").toLowerCase() === "submit" : tag === "input" && ["submit", "image"].includes(inputType);
    if (!presses) return false;
    const search =
      (form.getAttribute("role") || "").toLowerCase() === "search" ||
      form.closest("[role=search]") ||
      form.querySelector('input[type="search"]') ||
      Array.from(form.querySelectorAll("input[name]")).some((i) => /^(q|s|query|search|keywords?)$/i.test(i.getAttribute("name") || ""));
    return !search;
  }

  // A control keeps whatever id it was first given, so a [n] from an earlier look still names the
  // same element after the document shifts under it (a new chat message pushing an old Reply button
  // down). New elements draw from a counter seeded above every id already on the page, so a later run
  // never reuses one. "order" is the rank in THIS run's document order, which is what perceive sorts
  // by: id numbers no longer track document order once they stop being restamped every run.
  let counter = 0;
  for (const stamped of deepElements) {
    if (!stamped.hasAttribute("data-sue-id")) continue;
    const n = Number(String(stamped.getAttribute("data-sue-id")).split("-").pop());
    if (Number.isFinite(n) && n > counter) counter = n;
  }
  let order = 0;
  function nextId(el) {
    order += 1;
    const existing = el.getAttribute("data-sue-id");
    if (existing) return existing;
    counter += 1;
    const id = "sue-" + counter;
    el.setAttribute("data-sue-id", id);
    return id;
  }

  // FOLDED AWAY IS NOT ON HER SCREEN. What a closed <details> holds (a "More" fold) keeps its boxes and its
  // styles in Chrome, so size and style both said "visible" and its words were read: Lift's students
  // called a one-sentence card with the rest behind More "a wall of text" (kids' round 20). The browser
  // itself answers whether an element is drawn (checkVisibility: false under display:none or a skipped
  // content-visibility subtree, which is how a closed fold hides its contents).
  const foldedAway = (el) => typeof el.checkVisibility === "function" && !el.checkVisibility();

  function isVisible(el, rect, style) {
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    if (rect.width <= 0 && rect.height <= 0) return false;
    if (foldedAway(el)) return false;
    return true;
  }

  /**
   * What is on top of this control: behindOverlay, the words of the dialog or scrim in front of the
   * page; covered: true, when something that is NOT in front of the page sits on it (see
   * overlayOver); or nothing at all when she could actually hit it. (No backticks in here: this whole
   * script is one template literal.)
   *
   * ⛔ A CONTROL BEHIND A SCRIM IS NOT CLICKABLE, and until now nothing here knew that: visibility
   * was display/visibility/opacity/size only, none of which change for the whole page underneath an
   * open dialog. So a cookie-consent modal left every button on the page numbered, a Sue pressed one,
   * and the click hit the scrim. office-manager wrote it up as the product's fault - "clicking the
   * numbered 'Get started' button did nothing until I dealt with it" (run 20260922-090718-7a5f) -
   * which is a defect report about OUR perception, filed against their signup page. A real visitor
   * sees the page dimmed behind the dialog and never aims at it, so the fix is to stop offering it.
   *
   * It samples nine points across the control's own face rather than only its centre: a button half
   * under a sticky header is still perfectly clickable on its other half, and one centre sample would
   * retire it. Any sample that lands on the control (or on something inside it) proves reachability
   * and wins. A sample outside the viewport is not evidence either way - elementFromPoint answers
   * null there - so it is skipped, and a control with no testable point is left alone.
   */
  function coverFacts(el, rect) {
    // A control inside a frame is first behind whatever covers the frame itself.
    const frame = el.ownerDocument !== document && el.ownerDocument.defaultView ? el.ownerDocument.defaultView.frameElement : null;
    if (frame) {
      const outer = coverFacts(frame, frame.getBoundingClientRect());
      if (outer.covered || outer.behindOverlay) return outer;
    }
    const blocker = coverOf(el, rect);
    if (blocker === UNMEASURED) return modalOverUnmeasured(el);
    if (!blocker) return {};
    const surface = overlayOver(el, blocker);
    // Under something that is not in front of the page (its own search box, a sticky header): she
    // cannot press it, so it gets no number, but nothing stands between her and the page either.
    if (!surface) return { covered: true };
    // Name the SURFACE, not the pixel: the scrim itself has no words, so walk out to the dialog or
    // banner it belongs to and use its heading. Falling back to a generic phrase is fine - what she
    // needs is "something is in front of the page", never our class names.
    const dialog = deepClosest(blocker, OVERLAY_ROLES);
    const words = ((dialog || surface).innerText || "").trim().replace(/\\s+/g, " ");
    return { behindOverlay: words ? words.slice(0, 120) : "something in front of the page" };
  }

  /**
   * What sits on top of this control at every point she could aim at, or null when she can hit it.
   * A sample that lands in the control's own <label> counts as hitting it: a click there reaches the
   * control, in a browser and in Playwright alike.
   */
  function coverOf(el, rect) {
    if (rect.width <= 0 || rect.height <= 0) return null;
    const win = winOf(el);
    let blocker = null;
    let tested = false;
    for (const fx of [0.5, 0.2, 0.8]) {
      for (const fy of [0.5, 0.2, 0.8]) {
        const x = rect.left + rect.width * fx;
        const y = rect.top + rect.height * fy;
        if (x < 0 || y < 0 || x >= win.innerWidth || y >= win.innerHeight) continue;
        // The page answers with a web component's host; what is on top is inside its open shadow root.
        let top = el.ownerDocument.elementFromPoint(x, y);
        while (top && top.shadowRoot) {
          const inner = top.shadowRoot.elementFromPoint(x, y);
          if (!inner || inner === top || !deepContains(top, inner)) break;
          top = inner;
        }
        if (!top) continue;
        tested = true;
        if (top === el || deepContains(el, top) || deepContains(top, el)) return null;
        const label = top.closest("label");
        if (label && label.control === el) return null;
        if (!blocker) blocker = top;
      }
    }
    return tested ? blocker : UNMEASURED;
  }

  // coverOf's answer for a control with no point inside the viewport: neither reachable nor covered.
  const UNMEASURED = Symbol("unmeasured");

  /**
   * A control scrolled out of view cannot be hit-tested, but when a MODAL dialog is open and does not
   * hold it, the page behind is unreachable all the same: the dialog locks the page, and the
   * viewport shrinking under the on-screen keyboard pushed the background's own controls (the
   * listing page's Share your shop / Show me around / Dismiss) out of view, so they were left
   * numbered ahead of the dialog's and every index in the dialog shifted by three (run
   * 20261005-015234-dc78: description typed into Location, a tap near it opened Pay). A non-modal
   * banner is no such lock - the page still scrolls beneath it - so only a real modal counts.
   */
  function modalOverUnmeasured(el) {
    for (const dialog of el.ownerDocument.querySelectorAll("[role=dialog][aria-modal=true],[role=alertdialog][aria-modal=true],dialog[open]")) {
      if (dialog.matches("dialog:not([open])") || deepContains(dialog, el) || deepContains(el, dialog)) continue;
      const words = (dialog.innerText || "").trim().replace(/\\s+/g, " ");
      return { behindOverlay: words ? words.slice(0, 120) : "something in front of the page" };
    }
    return {};
  }

  const OVERLAY_ROLES = "[role=dialog],[role=alertdialog],[role=menu],[data-sue-banner],dialog";

  /**
   * The layer IN FRONT OF THE PAGE that the blocker belongs to, or null when the blocker only covers
   * this one control. Walking out from the blocker, the first element that also holds the control is
   * where the two share a layer, so the search stops there: a search box painted over its own
   * magnifier, or a sticky header over a button, is a cover, never "the rest of the page is behind
   * something" (every signed-in phone look said that of MyConnect's header, runs 20260922-115216-aa5f
   * and 20260922-133522-bbfb). What counts as in front: a dialog, a menu or a banner, or a layer
   * placed over at least half the screen each way (a scrim), which a full-screen app shell the
   * control lives in never is, because it holds the control.
   */
  function overlayOver(el, blocker) {
    const win = winOf(el);
    for (let node = blocker; node && node !== el.ownerDocument.documentElement; node = parentOf(node)) {
      if (deepContains(node, el)) return null;
      if (node.matches(OVERLAY_ROLES)) return node;
      const position = styleOf(node).position;
      if (position === "fixed" || position === "absolute") {
        const box = node.getBoundingClientRect();
        if (box.width >= win.innerWidth / 2 && box.height >= win.innerHeight / 2) return isOwnScreen(node, blocker) ? null : node;
      }
    }
    return null;
  }

  /**
   * A layer that fills the whole screen with paint of its own is the screen she is on, not something
   * in front of it: a phone's full-screen editor sheet hides the list it opened from entirely, so
   * nothing is behind it for her to deal with first (every look inside the host editor said there
   * was, run 20260922-171336-3009). A scrim is see-through, and she does see the page dimmed behind it.
   */
  function isOwnScreen(layer, blocker) {
    const box = layer.getBoundingClientRect();
    const win = winOf(layer);
    if (box.width < win.innerWidth * 0.9 || box.height < win.innerHeight * 0.9) return false;
    for (let node = blocker; node; node = parentOf(node)) {
      const style = styleOf(node);
      const bg = style.backgroundColor;
      const parts = bg.slice(bg.indexOf("(") + 1, bg.lastIndexOf(")")).split(",");
      const alpha = parts.length === 4 ? Number(parts[3]) : 1;
      if (style.backgroundImage !== "none" || (parts.length >= 3 && alpha >= 0.9)) return true;
      if (node === layer) break;
    }
    return false;
  }

  /**
   * Set when something is left out because a scroll box that still scrolls down clips it below: the page goes on past
   * her screen though the document itself does not scroll (an app whose list scrolls inside a box, as react-native-web
   * draws one). perceive() then names her screen's edge (Raise Buddy re-visit 24: a card the edge cut read empty).
   */
  let clippedBelow = false;

  /** Wholly past the edge of an ancestor whose overflow is not visible on that axis (hidden, clip or a scroll box: a marquee's copies off the strip). */
  function clippedOut(el, rect) {
    const clips = /^(hidden|clip|auto|scroll|overlay)$/;
    for (let p = parentOf(el); p && p !== el.ownerDocument.body && p !== el.ownerDocument.documentElement; p = parentOf(p)) {
      const s = styleOf(p);
      if (s.display === "contents") continue;
      const box = p.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (clips.test(s.overflowX) && (rect.right <= box.left || rect.left >= box.right)) return true;
      if (clips.test(s.overflowY) && (rect.bottom <= box.top || rect.top >= box.bottom)) {
        if (rect.top >= box.bottom && /^(auto|scroll|overlay)$/.test(s.overflowY) && p.scrollHeight - p.scrollTop - p.clientHeight > 1) clippedBelow = true;
        return true;
      }
    }
    return false;
  }

  function isHiddenElement(el, rect, style) {
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return true;
    if (rect.width <= 1 && rect.height <= 1) return true;
    if (rect.right <= 0 || rect.bottom <= 0) return true;
    const win = winOf(el);
    if (rect.left >= win.innerWidth * 4 || rect.top >= win.innerHeight * 4) return true;
    if (foldedAway(el)) return true;
    if (clippedOut(el, rect)) return true;
    return false;
  }

  /**
   * Words pushed past the page's left or top edge, where no scroll can take her: the kit's spam
   * honeypot sits 10,000 px off the left, and cleaning-rosa read its "Leave this field empty" label as
   * a line of the live sign-up form (run 20260927-090530-2886). Controls had this test
   * (isHiddenElement); words did not.
   */
  function pastPageEdge(rect, win) {
    return rect.right + win.scrollX <= 0 || rect.bottom + win.scrollY <= 0;
  }

  function aboveFold(rect) {
    return rect.top < window.innerHeight && rect.bottom > 0;
  }

  function findLabelText(el) {
    if (el.id) {
      const byFor = el.getRootNode().querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (byFor && byFor.innerText && byFor.innerText.trim()) return byFor.innerText.trim();
    }
    const wrapper = el.closest("label");
    if (wrapper && wrapper.innerText && wrapper.innerText.trim()) return wrapper.innerText.trim();
    return undefined;
  }

  /** A node's words without the boxes inside it: a label wrapping a drop-down is not its options. */
  function ownWords(node) {
    const copy = node.cloneNode(true);
    copy.querySelectorAll("select,input,textarea,button,option").forEach((inner) => inner.remove());
    return (copy.textContent || "").replace(/\\s+/g, " ").trim();
  }

  function labelledBy(el) {
    const ids = (el.getAttribute("aria-labelledby") || "").trim();
    if (!ids) return "";
    const root = el.getRootNode();
    return ids
      .split(/\\s+/)
      .map((ref) => root.getElementById(ref))
      .filter((node) => node && node !== el)
      .map(ownWords)
      .filter(Boolean)
      .join(" ");
  }

  /**
   * What a drop-down is CALLED: aria-label, aria-labelledby, its <label>, its title. Its innerText is
   * every option run together, so four channel pickers with the same options read as one box and a
   * Sue's choice landed in the wrong one (run 20260922-063426-626a).
   */
  function selectAccessibleName(el) {
    const aria = (el.getAttribute("aria-label") || "").trim();
    if (aria) return aria;
    return labelledBy(el) || labelWords(el) || (el.getAttribute("title") || "").trim();
  }

  /** The words of a box's own <label> (for= or wrapping), without the box's contents. */
  function labelWords(el) {
    for (const label of Array.from(el.labels || [])) {
      const words = ownWords(label);
      if (words) return words;
    }
    return "";
  }

  /**
   * The words ON an element that a sighted person can see. innerText keeps a visually hidden
   * (sr-only) span's words, so a picture button carrying one read as a worded button.
   */
  function seenText(el) {
    const parts = [];
    // Its words include those a web component inside it draws from its open shadow root.
    const texts = [];
    deepWalk(el, false, (node) => {
      if (node.nodeType === 3) texts.push(node);
    });
    for (const node of texts) {
      const parent = parentOf(node);
      let hidden = false;
      for (let p = parent; p; p = p === el ? null : parentOf(p)) {
        if (isHiddenElement(p, p.getBoundingClientRect(), styleOf(p))) {
          hidden = true;
          break;
        }
      }
      // An icon font draws its ligature as a picture: "expand_more" is an arrow on the screen, and the
      // kit's birthday Month picker reached a Sue as "Monthexpand_more" (run 20260922-224205-261f).
      if (!hidden && parent && ICON_FONT.test(styleOf(parent).fontFamily)) hidden = true;
      if (!hidden) parts.push(node.textContent || "");
    }
    return parts.join(" ").replace(/\\s+/g, " ").trim();
  }

  /** A node's words only when a sighted person can see them: a visually hidden label is a screen reader's. */
  function shownWords(node) {
    if (!node) return "";
    return isHiddenElement(node, node.getBoundingClientRect(), styleOf(node)) ? "" : ownWords(node);
  }

  /**
   * The words a sighted person SEES naming a box: its printed <label>, or visible text it points at
   * with aria-labelledby. Never aria-label or a title tooltip: those are nowhere on the screen.
   */
  function seenLabel(el) {
    for (const label of Array.from(el.labels || [])) {
      const words = shownWords(label);
      if (words) return words;
    }
    const ids = (el.getAttribute("aria-labelledby") || "").trim();
    if (!ids) return "";
    const root = el.getRootNode();
    return ids
      .split(/\\s+/)
      .map((ref) => root.getElementById(ref))
      .filter((node) => node && node !== el)
      .map(shownWords)
      .filter(Boolean)
      .join(" ");
  }

  const result = {
    url: location.href,
    title: document.title,
    // the page's own language: a Spanish page is graded as Spanish reading (lib/readability.mjs)
    lang: (document.documentElement.getAttribute("lang") || "").toLowerCase(),
    viewport: { w: window.innerWidth, h: window.innerHeight },
    blocks: [],
    elements: [],
    overlays: [],
    captcha: { present: false, interactive: false },
    scroll: { y: window.scrollY, max: Math.max(0, document.documentElement.scrollHeight - window.innerHeight) },
    // Until the page's load finishes, a browser shows it loading (the tab's spinner, a bar across the top).
    loading: document.readyState !== "complete",
  };

  /**
   * The radio or checkbox a label CARD stands for, when the box itself is visually hidden: the
   * kit's row-style option cards (AppOptionCardRadioGroup) hide the real radio and draw the label as
   * the thing to press. Numbering the hidden radio left the card unreachable, and a Sue asking for
   * "Memoir" in Book's New book dialog was told nothing on the page said it (run 20260923-060828-9797).
   */
  function hiddenChoiceOf(label) {
    const control = label.control;
    if (!control || control.tagName !== "INPUT" || !/^(radio|checkbox)$/i.test(control.type)) return null;
    return isHiddenElement(control, control.getBoundingClientRect(), styleOf(control)) ? control : null;
  }
  const cardLabelOf = (input) => Array.from(input.labels || []).find((label) => hiddenChoiceOf(label) === input && !deepClosest(label, "[inert]"));

  /**
   * WORDS IN A PLAIN BOX ARE WORDS ON HER SCREEN. Only headings, paragraphs, list items, cells and
   * controls were read, so a line a page prints in a bare <div> never reached a look. Lift's lessons
   * say "Yes!" or "Not quite" under every pick in one, and three rounds of simulated students said "it
   * never told me if I got my answers right so it felt like tapping for nothing" (kids' rounds 18 to 20).
   * A box that holds loose words (the nearest box that is not inline) is read as one block: its own
   * words and those of the inline links in the sentence, never the words of a paragraph or a control
   * inside it, which have readers of their own. Words with no letter or digit (a decorative emoji) are
   * no block. The box is marked so the one walk below meets it in document order.
   */
  const LOOSE = "data-sue-loose";
  const NOT_PROSE = "script,style,noscript,template,head,select,textarea,option,svg,math,canvas,iframe,object";
  for (const old of deepElements) if (old.hasAttribute(LOOSE)) old.removeAttribute(LOOSE);
  const looseWords = new Map();
  const blockTextOf = new Map();
  const inlineBox = (el) => {
    const display = styleOf(el).display;
    return display === "inline" || display === "contents";
  };
  for (const node of deepTexts) {
    const words = node.textContent || "";
    const parent = parentOf(node);
    if (!words.trim() || !parent || parent.closest(NOT_PROSE)) continue;
    // Loose words inside a closed fold are folded away with it; only its <summary> is on her screen.
    if (deepClosest(parent, "details:not([open])") && !deepClosest(parent, "summary")) continue;
    let host = parent;
    while (parentOf(host) && host !== host.ownerDocument.body && inlineBox(host)) host = parentOf(host);
    if (deepClosest(host, COMBINED_SELECTOR)) continue;
    let seen = !ICON_FONT.test(styleOf(parent).fontFamily);
    for (let p = parent; seen && p !== host; p = parentOf(p)) {
      const pStyle = styleOf(p);
      if (pStyle.display === "none" || pStyle.visibility === "hidden" || Number(pStyle.opacity) === 0) seen = false;
    }
    if (!seen) continue;
    let entry = looseWords.get(host);
    if (!entry) {
      entry = { parts: [], first: null, last: null };
      looseWords.set(host, entry);
    }
    // A line break between two runs of words is a space to her, never "Show your teacherFinished the lesson".
    const before = node.previousSibling || (node === parent.firstChild && parent !== host ? parent.previousSibling : null);
    entry.parts.push(before && before.nodeName === "BR" ? " " + words : words);
    // An inline link's words ride in the sentence; only words that belong to no reader make the box a block.
    if (!deepClosest(parent, COMBINED_SELECTOR) && /[\\p{L}\\p{N}]/u.test(words)) {
      if (!entry.first) entry.first = node;
      entry.last = node;
    }
  }
  for (const [host, entry] of looseWords) {
    if (entry.first) host.setAttribute(LOOSE, "");
    else looseWords.delete(host);
  }

  const READ_SELECTOR = COMBINED_SELECTOR + ",[" + LOOSE + "]";
  // A SIGHTED PERSON SEES A PICTURE AT A GLANCE; words said nothing where one sat, so a Sue asked about "this shark
  // photo" wrote that she saw no photo while it filled half her screen (Lift class round, 2026-10-03). A shown box of
  // 80 by 80 or more is a picture block with no words: never its alt, aria-label or title (a visitor sees the picture,
  // not its alt text). A picture on a control is part of the control; a loaded <img> only, so a broken one is no photo.
  const PICTURE_TAGS = new Set(["img", "svg", "canvas", "video"]);
  const MIN_PICTURE_PX = 80;
  const pictureOf = (el, tag) => {
    if (tag === "html" || tag === "body") return false;
    if (PICTURE_TAGS.has(tag)) {
      if (tag === "img" && !(el.complete && el.naturalWidth > 0)) return false;
      if (tag === "svg" && el.parentNode && el.parentNode.closest && el.parentNode.closest("svg")) return false;
    } else if (!/url\\(/.test(styleOf(el).backgroundImage || "")) return false;
    if (deepClosest(el, INTERACTIVE_SELECTOR)) return false;
    // A numbered choice card (a label over a hidden radio) is a control; its photo is part of it.
    const card = deepClosest(el, "label");
    return !(card && hiddenChoiceOf(card));
  };
  // A url() background paints its image, not its box: a 16 px tile on a 200 px div is a speck, and an image that has
  // not loaded paints nothing. The image is resolved through one cached Image per url (kept on the page, so a later
  // look finds it loaded); the drawn size follows background-size, and a repeating background tiles the whole box.
  const loadedImages = window.__sueBackgroundImages || (window.__sueBackgroundImages = new Map());
  const paintedSize = (el, box, style) => {
    const url = /url\\((["']?)(.*?)\\1\\)/.exec(style.backgroundImage || "");
    if (!url) return null;
    let image = loadedImages.get(url[2]);
    if (!image) {
      image = new Image();
      image.src = url[2];
      loadedImages.set(url[2], image);
    }
    if (!(image.complete && image.naturalWidth > 0)) return null;
    if (style.backgroundRepeat.split(",")[0].trim() !== "no-repeat") return { w: box.width, h: box.height };
    const [wide, high = "auto"] = style.backgroundSize.split(",")[0].trim().split(/\\s+/);
    if (wide === "cover" || wide === "contain") return { w: box.width, h: box.height };
    const length = (value, of) => (value === "auto" ? null : value.endsWith("%") ? (of * parseFloat(value)) / 100 : parseFloat(value));
    let w = length(wide, box.width);
    let h = length(high, box.height);
    if (w === null && h === null) return { w: image.naturalWidth, h: image.naturalHeight };
    if (w === null) w = (h * image.naturalWidth) / image.naturalHeight;
    if (h === null) h = (w * image.naturalHeight) / image.naturalWidth;
    return { w, h };
  };
  deepElements.forEach((el) => {
    const pictureTag = el.tagName.toLowerCase();
    if (el.nodeType === 1 && pictureOf(el, pictureTag)) {
      const box = el.getBoundingClientRect();
      const drawn = PICTURE_TAGS.has(pictureTag) ? { w: box.width, h: box.height } : paintedSize(el, box, styleOf(el));
      if (
        drawn &&
        box.width >= MIN_PICTURE_PX &&
        box.height >= MIN_PICTURE_PX &&
        drawn.w >= MIN_PICTURE_PX &&
        drawn.h >= MIN_PICTURE_PX &&
        isVisible(el, box, styleOf(el)) &&
        !pastPageEdge(box, winOf(el))
      ) {
        const placed = onScreen(el, box);
        const pictureId = nextId(el);
        result.blocks.push({
          id: pictureId,
          order,
          kind: "picture",
          text: "",
          wordCount: 0,
          aboveFold: aboveFold(placed),
          top: Math.round(placed.top),
          bottom: Math.round(placed.bottom),
        });
      }
    }
    if (!el.matches(READ_SELECTOR)) return;
    const tag = el.tagName.toLowerCase();
    const rect = el.getBoundingClientRect();
    const style = styleOf(el);
    // Measured in its own frame; where it sits on her screen is the frame's place plus that.
    const shown = onScreen(el, rect);

    const loose = looseWords.get(el);
    if (loose) {
      // A box one pixel big is a screen reader's (an sr-only span), never hers.
      if (!isVisible(el, rect, style) || (rect.width <= 1 && rect.height <= 1) || clippedOut(el, rect)) return;
      const range = el.ownerDocument.createRange();
      range.setStartBefore(loose.first);
      range.setEndAfter(loose.last);
      let wordsRect = range.getBoundingClientRect();
      // Words that start outside a web component and end inside it make no one range: the box stands in.
      if (loose.first.getRootNode() !== loose.last.getRootNode() || (wordsRect.width === 0 && wordsRect.height === 0)) wordsRect = rect;
      if (pastPageEdge(wordsRect, winOf(el))) return;
      const text = loose.parts.join("").replace(/\\s+/g, " ").trim();
      if (!text) return;
      // The same words already read as an enclosing block (a list item and the span inside it) are one line, not two.
      for (let up = parentOf(el); up; up = parentOf(up)) if (blockTextOf.get(up) === text) return;
      const wordsShown = onScreen(el, wordsRect);
      const id = nextId(el);
      result.blocks.push({
        id,
        order,
        kind: "other",
        text,
        fontPx: wordsPx(el),
        aboveFold: aboveFold(wordsShown),
        wordCount: text.split(" ").filter(Boolean).length,
        bottom: Math.round(wordsShown.bottom),
      });
      return;
    }

    // The card is numbered in the box's place (hiddenChoiceOf); the hidden box itself is skipped.
    if (tag === "input" && cardLabelOf(el)) return;
    const choice = tag === "label" && !deepClosest(el, "[inert]") ? hiddenChoiceOf(el) : null;
    if (choice) {
      if (!isVisible(el, rect, style)) return;
      const words = ownWords(el);
      result.elements.push({
        id: nextId(el),
        order,
        role: choice.type.toLowerCase(),
        name: words || (choice.getAttribute("aria-label") || "").trim(),
        hasVisibleText: Boolean(seenText(el)),
        iconOnly: false,
        fontPx: glassPx(el, style, rect),
        rect: { x: Math.round(shown.x), y: Math.round(shown.y), w: Math.round(shown.width), h: Math.round(shown.height) },
        aboveFold: aboveFold(shown),
        inputType: choice.type.toLowerCase(),
        hidden: isHiddenElement(el, rect, style),
        ...coverFacts(el, rect),
        seenText: seenText(el) || undefined,
        disabled: Boolean(choice.disabled),
      });
      return;
    }

    // ⛔ A CONTROL INSIDE AN INERT SUBTREE IS PART OF A PICTURE: no click, hover or focus can land
    // on it, so it gets no number and its words are read like any other text. The homepage's sample
    // workspace is exactly that, and ten Sues pressed its numbered "Events" until the click timed
    // out, then filed "a picture pretending to be buttons" (run 20260922-133522-c2bd).
    if (el.matches(INTERACTIVE_SELECTOR) && !deepClosest(el, "[inert]")) {
      const ariaRole = (el.getAttribute("role") || "").trim().toLowerCase();
      const inputType = tag === "input" ? (el.getAttribute("type") || "text").toLowerCase() : "";
      const editable = tag !== "textarea" && tag !== "input" && (el.isContentEditable || ariaRole === "textbox");
      const takesText = tag === "select" || tag === "textarea" || editable || (tag === "input" && !NOT_TEXT_INPUTS.includes(inputType));
      let role = "other";
      if (!takesText && ARIA_WIDGET_ROLES.includes(ariaRole)) role = ariaRole;
      else if (tag === "button" || tag === "summary" || ariaRole === "button") role = "button";
      else if (tag === "a") role = "link";
      else if (tag === "select") role = "select";
      else if (tag === "textarea" || editable) role = "textarea";
      else if (tag === "input") {
        if (inputType === "checkbox") role = "checkbox";
        else if (inputType === "radio") role = "radio";
        // An input that acts when pressed (submit, button, image, reset) is a press, read like a
        // button: called "a box to type in" it would be exempt from the borrowed real-change rail.
        else if (NOT_TEXT_INPUTS.includes(inputType)) role = "button";
        else role = "input";
      }

      const visibleText = (el.innerText || "").trim();
      const shownText = tag === "select" ? visibleText : seenText(el);
      const hasVisibleText = Boolean(shownText);
      const ariaLabel = (el.getAttribute("aria-label") || "").trim();
      const title = (el.getAttribute("title") || "").trim();
      const nameAttr = (el.getAttribute("name") || "").trim();
      let name = visibleText || ariaLabel || labelledBy(el) || title || nameAttr;
      // An editable block's text is what she has typed so far, not what the box is called.
      if (editable) name = ariaLabel || labelledBy(el) || title || visibleText || "a text box";
      // A drop-down is called by its label, then by what it shows now; its choices ride beside it.
      let options;
      let selected;
      let labelText = findLabelText(el);
      if (role === "select") {
        // A wrapping label's innerText carries every option too; a choice's words must not match the box's label.
        labelText = labelWords(el) || undefined;
        options = Array.from(el.options || [])
          .slice(0, 200)
          .map((option) => (option.label || option.text || "").replace(/\\s+/g, " ").trim());
        selected = el.selectedIndex >= 0 ? options[el.selectedIndex] || undefined : undefined;
        // Never the options run together (Chrome's innerText of a select), which is what made look-alike
        // pickers one box: an unlabelled list with nothing chosen is just a list, and its choices are listed.
        name = selectAccessibleName(el) || selected || nameAttr || "a list";
      }
      // A control with a printed label beside it is named by that label, never a picture button.
      const printedLabel = seenLabel(el) || undefined;
      const iconOnly = !hasVisibleText && !printedLabel && ["button", "link", "menuitem", "tab"].includes(role);
      const fontPx = wordsPx(el);
      const id = nextId(el);

      result.elements.push({
        id,
        order,
        role,
        name,
        hasVisibleText,
        iconOnly,
        fontPx,
        rect: { x: Math.round(shown.x), y: Math.round(shown.y), w: Math.round(shown.width), h: Math.round(shown.height) },
        aboveFold: aboveFold(shown),
        href: tag === "a" ? el.getAttribute("href") || undefined : undefined,
        inputType: tag === "input" ? (el.getAttribute("type") || "text").toLowerCase() : undefined,
        // A press that sends its form (a submit button, or a button with no type, in a form that is not
        // a search): on somebody else's live website that reaches a real person, whatever the button
        // says, and the live-site rail refuses it (lib/rails.mjs refusedBy). Same reading as keyPressTargets.
        submits: sendsItsForm(el, tag, inputType) || undefined,
        hidden: isHiddenElement(el, rect, style),
        // behindOverlay (the words of the dialog/scrim in front of it) or covered - see coverFacts.
        ...coverFacts(el, rect),
        autocomplete: el.getAttribute("autocomplete") || undefined,
        labelText,
        seenText: shownText || undefined,
        seenLabel: printedLabel,
        placeholder: el.getAttribute("placeholder") || undefined,
        // What a big box already holds is on her screen like any words: a lesson's sentence starter filled one and
        // the Sue, shown only its label, said "it didnt put the words in the box" (run 20260930-231724-a54e). Big
        // boxes only: a one-line box can hold a password or a sign-in code, which never reaches a look or a log; nor does
        // a big box that masks its text, asks to be filled as a secret, or is named like one (a pasted key, a token).
        // One line of plain text: a box's line breaks would split the numbered list of what she sees.
        filled: tag === "textarea" && el.value.trim()
          && !/password|one-time-code|cc-/i.test(el.getAttribute("autocomplete") || "")
          && !["disc", "circle", "square"].includes(style.getPropertyValue("-webkit-text-security"))
          && !/pass|secret|token|api.?key|private.?key|otp/i.test((el.name || "") + " " + (el.id || "") + " " + (labelText || ""))
          ? el.value.trim().replace(/\\s+/g, " ").slice(0, 200) : undefined,
        // A widget built from a div has no disabled property; aria-disabled is how it greys out.
        disabled: Boolean(el.disabled) || (ARIA_WIDGET_ROLES.includes(role) && el.getAttribute("aria-disabled") === "true"),
        options,
        selected,
        // A drop-down drawn from a button (the kit's month picker): pressed, it opens a list. The type tool
        // aimed at one tells her so instead of calling it "not a box" (run 20260922-224205-261f).
        listTrigger: !takesText && (ariaRole === "combobox" || el.getAttribute("aria-haspopup") === "listbox") ? true : undefined,
      });
      return;
    }

    if (!isVisible(el, rect, style) || pastPageEdge(rect, winOf(el)) || clippedOut(el, rect)) return;
    if (CONTAINER_TAGS.has(tag) && el.querySelector(NESTED_READABLE)) return;
    // A label wrapping a drop-down reads as its own words; its innerText is also every option.
    const text =
      tag === "label" && el.querySelector("select") ? ownWords(el) : (el.innerText || el.textContent || "").trim().replace(/\\s+/g, " ");
    if (!text) return;

    let kind = "other";
    let level;
    if (/^h[1-6]$/.test(tag)) {
      kind = "heading";
      level = Number(tag[1]);
    } else if (tag === "p" || tag === "blockquote") kind = "paragraph";
    else if (tag === "label") kind = "label";
    else if (tag === "li") kind = "list";
    else if (tag === "pre") kind = "code";
    else if (tag === "td" || tag === "th") kind = "cell";
    else if (tag === "caption" || tag === "figcaption") kind = "caption";

    const fontPx = wordsPx(el);
    const wordCount = text.split(" ").filter(Boolean).length;
    for (let up = parentOf(el); up; up = parentOf(up)) if (blockTextOf.get(up) === text) return;
    const id = nextId(el);
    blockTextOf.set(el, text);
    result.blocks.push({ id, order, kind, level, text, fontPx, aboveFold: aboveFold(shown), wordCount, bottom: Math.round(shown.bottom) });
  });

  deepElements.forEach((el) => {
    if (!el.matches('[role="dialog"], [role="alertdialog"], [role="menu"], [data-sue-banner]')) return;
    const rect = el.getBoundingClientRect();
    const style = styleOf(el);
    if (!isVisible(el, rect, style)) return;
    const role = el.getAttribute("role");
    let kind = "banner";
    if (role === "dialog" || role === "alertdialog") kind = "dialog";
    else if (role === "menu") kind = "menu";
    const text = (el.innerText || "").trim().replace(/\\s+/g, " ").slice(0, 300);
    result.overlays.push({ kind, text });
  });

  const captchaFrame = Array.from(document.querySelectorAll("iframe")).find((frame) =>
    /${CAPTCHA_FRAME.source}/i.test(frame.getAttribute("src") || ""),
  );
  if (captchaFrame) {
    const src = captchaFrame.getAttribute("src") || "";
    const rect = captchaFrame.getBoundingClientRect();
    let kind = "other";
    if (/recaptcha/i.test(src)) kind = "recaptcha";
    else if (/hcaptcha/i.test(src)) kind = "hcaptcha";
    else if (/turnstile|cloudflare/i.test(src)) kind = "turnstile";
    result.captcha = { present: true, kind, interactive: rect.width > 50 && rect.height > 50 };
  } else {
    // Turnstile renders its iframe inside a CLOSED shadow root on the host element, so no
    // querySelectorAll ever sees it (a live Sue met the "Verify you are human" box on 2026-09-21
    // and the body logged it as a plain confusion). The host element itself is visible: with
    // appearance "interaction-only" it is 0x0 until Cloudflare decides a human must click, then it
    // grows to the ~300x65 widget - so a host with real height IS the interactive challenge.
    const host = Array.from(
      document.querySelectorAll('.cf-turnstile, [id^="cf-turnstile"], [data-sitekey], .g-recaptcha, .h-captcha'),
    ).find((el) => el.getBoundingClientRect().height > 20);
    if (host) {
      const rect = host.getBoundingClientRect();
      const cls = host.className + " " + host.id;
      const kind = /recaptcha/i.test(cls) ? "recaptcha" : /h-captcha/i.test(cls) ? "hcaptcha" : "turnstile";
      result.captcha = { present: true, kind, interactive: rect.width > 50 && rect.height > 50 };
    }
  }

  result.clippedBelow = clippedBelow;
  return result;
})()`;

/** The rank a `sue-<n>` id's trailing number implies, for an inventory with no per-run `order`. */
function idOrder(id) {
  const n = Number(String(id).split("-").pop());
  return Number.isFinite(n) ? n : 0;
}

/** How many of a drop-down's choices a look shows beside it; clicking the box by number shows them all. */
const CHOICES_PER_LOOK = 8;

/**
 * A drop-down's choices, in order: the inventory's `options`, or (an inventory without them) every
 * line of its name but the first, which is what it shows.
 */
export function selectChoices(el) {
  if (Array.isArray(el?.options)) return el.options.map((o) => String(o ?? "").trim()).filter(Boolean);
  return String(el?.name ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(1);
}

/** The line a look shows for a drop-down: its name, what it shows now when that is not its name, and its first choices. */
function selectLine(el) {
  if (!Array.isArray(el.options)) {
    const name = String(el.name ?? "")
      .split("\n")[0]
      .trim();
    const choices = selectChoices(el);
    const shown = choices.slice(0, CHOICES_PER_LOOK).join(", ");
    return `${name || "a list"} [a drop-down list${shown ? `: ${shown}${choices.length > CHOICES_PER_LOOK ? ", ..." : ""}` : ""}]`;
  }
  // Called by the label a person can see; with none, by what it shows now (a hidden label is not seen).
  const name = seenName(el);
  const choices = selectChoices(el).filter((choice) => choice !== name);
  const showing = el.selected && el.selected !== name ? ` showing "${el.selected}"` : "";
  const shown = choices.slice(0, CHOICES_PER_LOOK).join(", ");
  return `${name} [a drop-down list${showing}${shown ? `: ${shown}${choices.length > CHOICES_PER_LOOK ? ", ..." : ""}` : ""}]`;
}

/** What a control with no words a person can see looks like, by its role. */
const UNWORDED_LOOKS = {
  input: "a box to type in",
  textarea: "a big box to type in",
  checkbox: "a tick box with no words",
  radio: "a round choice with no words",
  switch: "an on/off switch with no words",
  button: "a button with no words",
  link: "a link with no words",
};

/**
 * The words a sighted person can SEE naming an inventory element - the words on it, its printed
 * label, visible text it points at, its placeholder, what a drop-down shows - or "" when there are
 * none. Never its aria-label or tooltip (the hidden-label ruling in perceive). Everything that TELLS
 * her a name or matches a name she TYPES goes through this; the inventory's own `name` (the page's
 * name for it, hidden or not) stays for the rails and for the report we read.
 */
export function seenWords(el) {
  if (!el) return "";
  if (el.role === "select") return String(el.seenLabel || "").trim() || String(el.selected || "").trim();
  // A box's placeholder disappears the moment it holds anything, so a filled box is named by its label only.
  return String((el.hasVisibleText ? (el.seenText ?? el.name) : el.seenLabel || (el.filled ? "" : el.placeholder)) || "").trim();
}

/** {@link seenWords}, or what it looks like when it has none ("a button with no words"). */
export function seenName(el) {
  const words = seenWords(el);
  if (words) return words;
  if (el?.iconOnly) return "a picture button with no words";
  if (el?.role === "select") return "a list";
  // A bare file box draws itself as a "Choose File" button, never as a box to type in.
  if (String(el?.inputType ?? "").toLowerCase() === "file") return "a Choose File button";
  return UNWORDED_LOOKS[el?.role] ?? `a ${el?.role ?? "thing"} with no words`;
}

/** Does `text` name a hamburger/menu control, for the icon-only rendering? */
function isMenuIcon(text) {
  return /menu|hamburger|navigation/i.test(String(text || ""));
}

/**
 * Render `inventory` through one persona's dials. Returns the text a `look` shows her, a
 * `clickable` map from her `[n]` numbering back to the element's `data-sue-id`, and the stats the
 * body appends to findings.jsonl (`tiny-text`, `reading-grade-over-head`, plus the raw word counts
 * `report.mjs`'s clock section reads).
 */
export function perceive(inventory, persona) {
  const dials = persona && typeof persona === "object" && persona.dials ? persona.dials : persona || {};
  const readingGrade = dials.readingGrade ?? 12;
  const wordsPerLook = Number(dials.wordsPerLook) || 0;
  const legibleMinPx = Number(dials.legibleMinPx) || 0;
  const techProwess = Number(dials.techProwess) || 3;

  const blocks = inventory.blocks || [];
  const elements = inventory.elements || [];

  // Merge the two arrays into document order by the rank the inventory stamped on each this run; an
  // older or hand-built inventory with no `order` falls back to its id's trailing number, which is
  // what ranked it before ids became stable across runs.
  const rankOf = (item) => (Number.isFinite(Number(item.order)) ? Number(item.order) : idOrder(item.id));
  const merged = [
    ...blocks.map((item) => ({ type: "block", item, order: rankOf(item) })),
    ...elements.map((item) => ({ type: "element", item, order: rankOf(item) })),
  ].sort((a, b) => a.order - b.order);

  const wordsTotal = blocks.reduce((sum, block) => sum + (block.wordCount || 0), 0);

  const lines = [];
  const clickable = new Map();
  /** What she actually read this look, block by block, so the body charges her clock only for words new to her. */
  const readBlocks = [];
  let wordsShown = 0;
  let tinyText = 0;
  let overHead = 0;
  let truncated = false;
  let elementNumber = 0;
  /** Said once per look, not once per control the dialog is covering. */
  let saidBlocked = false;

  // techProwess 4-5: she sees the URL bar (SPEC.md). Below that she is never told about the URL at
  // all - this line is the whole of that half of the dial; an icon with no words stays a picture at
  // every level (`[an icon button]` above 1-2, from the icon branch below), never a name.
  if (techProwess >= 4) {
    lines.push(`[address bar] ${inventory.url} (${inventory.title})`);
  }
  // Her eyes start where the SCREEN is, not at the top of the document. Until 2026-09-21 every look
  // re-read the page from its first word, so a skimmer (`wordsPerLook` 40-150) who scrolled down saw
  // the same opening words again and could never read or click anything below them: on Example App
  // Next's homepage that was everything past the hero. What she has scrolled past is gone from view
  // unless it sticks to the screen (a sticky header's rect is still on screen, so it stays).
  const scrolledPast = (entry) => {
    const bottom = entry.type === "block" ? entry.item.bottom : entry.item.rect ? entry.item.rect.y + entry.item.rect.h : undefined;
    return typeof bottom === "number" && bottom <= 0;
  };
  // What the browser itself shows while a page arrives: a white screen with a spinning tab is a page
  // on its way, not a dead one (a Sue filed "blank white page" a second after a click, run
  // 20260922-133522-c2bd). A page that has loaded and is still white says nothing, and is hers to judge.
  if (inventory.loading === true) lines.push("[the page is still loading]");
  if (Number(inventory.scroll?.y) > 0) lines.push("[you have scrolled partway down the page]");
  // Running out of words stops her READING, not seeing. A button or a box on her screen is still in
  // the picture she is looking at, so it keeps its number; words, links (a link is words to read)
  // and what is below the screen go. Until 2026-09-22 the first spent word hid every control after it in page order: a distracted
  // Sue in a Discord ticket never got a number for the message box at the bottom of her screen,
  // pointed at it, was told to click it, and gave up unable to type (run 20260922-113917-5468).
  // A link on her screen is the same: a partner email's big "Make my booking link" button is a link,
  // and skimmers hit their reading cut before it, so it got no number and "Connections" could not be
  // clicked by its text (run 20261006-063506-50e9). Only prose is cut, never a control she can see.
  const screenHeight = Number(inventory.viewport?.h) || 0;
  let windowEdgeAt = "";
  // Her read stops at her screen when it is one screen at a time (paced reading) or when the page's list scrolls inside a
  // box that clips the rest (the inventory's clippedBelow). Then the thing the bottom edge cuts is named as her window's
  // edge, or, when the edge falls between two things and the page goes on below, the lowest thing she read whole.
  const screenLimited = inventory.screenOnly === true || inventory.clippedBelow === true;
  const goesOnBelow = inventory.moreBelow === true || inventory.clippedBelow === true;
  const firstWords = (words) => String(words).trim().split(/\s+/).slice(0, 6).join(" ");
  let lastOnScreen = "";
  let lastBottom = -Infinity;
  const standsOutOnScreen = (el) => screenHeight > 0 && el.rect && el.rect.y < screenHeight && el.rect.y + el.rect.h > 0;

  for (const entry of merged) {
    if (scrolledPast(entry)) continue;
    // A picture costs no words, so running out of them does not take it from her screen (like a control).
    const isPicture = entry.type === "block" && entry.item.kind === "picture";
    if (truncated && (isPicture ? entry.item.aboveFold !== true : entry.type === "block" || !standsOutOnScreen(entry.item))) continue;

    if (isPicture) {
      lines.push("[a picture]");
      continue;
    }

    if (entry.type === "block") {
      const block = entry.item;

      if (legibleMinPx > 0 && block.fontPx > 0 && block.fontPx < legibleMinPx) {
        tinyText += 1;
        lines.push("[tiny print you cannot make out]");
        continue;
      }

      let displayText = block.text;
      let shownWords = block.wordCount || 0;
      const grade = isGradeable(block.text) ? readingGradeOf(block.text, inventory.lang) : 0;
      if (grade > readingGrade) {
        overHead += 1;
        const firstSentenceMatch = block.text.match(/[^.!?]+[.!?]?/);
        const firstSentence = (firstSentenceMatch ? firstSentenceMatch[0] : block.text).trim();
        displayText = firstSentence + " [this is hard to read - you skim it and are not sure what it means]";
        shownWords = firstSentence.split(/\s+/).filter(Boolean).length;
      }

      if (wordsPerLook > 0 && wordsShown + shownWords > wordsPerLook) {
        const remaining = Math.max(0, wordsPerLook - wordsShown);
        const partial = displayText.split(/\s+/).slice(0, remaining).join(" ");
        lines.push((partial ? partial + " " : "") + "[... you stopped reading here]");
        wordsShown += remaining;
        readBlocks.push({ key: `${block.id}:${block.text.slice(0, 80)}`, words: remaining });
        truncated = true;
        continue;
      }

      // On a one-screen read, a block the bottom edge cuts says so, so she never reports the fold as a site defect.
      if (!windowEdgeAt && screenLimited && screenHeight > 0 && block.aboveFold === true && block.bottom > screenHeight)
        windowEdgeAt = firstWords(block.text);
      if (block.aboveFold === true && block.bottom <= screenHeight && block.bottom > lastBottom)
        [lastOnScreen, lastBottom] = [firstWords(block.text), block.bottom];
      lines.push(displayText);
      wordsShown += shownWords;
      readBlocks.push({ key: `${block.id}:${block.text.slice(0, 80)}`, words: shownWords });
      continue;
    }

    const el = entry.item;
    // A real visitor never perceives an off-screen honeypot at all - SPEC.md's boundary is "the
    // brain NEVER sees our code", so a hidden element gets no number, no line and no clickable
    // entry, not a "(hidden)" tag that would hand the brain our trap detection verbatim.
    if (el.hidden) continue;
    // Behind a dialog or a scrim: a sighted visitor sees the page dimmed and knows the dialog comes
    // first, so she is told that ONCE and the unreachable controls get no numbers. Numbering them is
    // what made a Sue press "Get started" through a cookie modal and report the button as broken.
    if (el.behindOverlay) {
      if (!saidBlocked) {
        saidBlocked = true;
        lines.push(`[the rest of the page is behind "${String(el.behindOverlay).slice(0, 80)}" - deal with that first]`);
      }
      continue;
    }
    // Under something that is NOT in front of the page (a search box painted over its own magnifier,
    // a sticky header): no number, since a press lands on what is on top, and no notice, since the
    // page is not blocked. She still sees it in her picture, and point reaches whatever is on top.
    if (el.covered) continue;
    elementNumber += 1;

    // What she is told a thing is called is only what a sighted person can SEE on it or beside it:
    // its own words, its printed label, visible text it points at, its placeholder. A hidden label
    // (aria-label, a title tooltip, a visually hidden <label>) is written for a screen reader and no
    // sighted visitor ever reads it (Owner, 2026-09-22: "They should build this page for humans. I
    // don't want the AIs seeing a label that says button here and being like, oh, it's so obvious.
    // When a human would have no idea what to do"). So an icon with no words is a picture at every
    // level of tech skill: she sees the icon in her screenshot and can point at it, like anyone.
    let label = seenWords(el) || `[${seenName(el)}]`;
    if (el.iconOnly) {
      label = isMenuIcon(el.name || el.labelText)
        ? "[three little lines]"
        : techProwess <= 2
          ? "[a small picture button with no words]"
          : "[an icon button]";
    }

    // A person sees a drop-down as a box with a label, showing its current choice, and knows it is
    // a list. The inventory names it by its label (then by what it shows) and carries its choices
    // beside it, so four look-alike channel pickers read as four different boxes (run
    // 20260922-063426-626a). An inventory without `options` names it by its options run together
    // ("Pick a channel... #general #welcome ..."): the first is the name, the rest the choices.
    // A greyed-out button LOOKS greyed out: without saying so, a Sue waited out the click timeout
    // on a disabled "Save panel" and filed it as broken (2026-09-21).
    if (el.role === "select") label = selectLine(el);
    if (el.disabled) label = `${label} [greyed out]`;
    // its own double quotes become single ones, so the box's words never close the quote around them
    if (el.filled)
      label = `${label} [holding: "${(el.filled.length > 120 ? `${el.filled.slice(0, 119)}…` : el.filled).replace(/"/g, "'")}"]`;
    // A CONTROL'S OWN WORDS ARE PRINT TOO. A game's text is nearly all on its buttons, and only blocks were
    // ever held to her eyesight, so a phone HUD of 11px buttons passed every look (SUE focus group 22).
    if (legibleMinPx > 0 && el.hasVisibleText && el.fontPx > 0 && el.fontPx < legibleMinPx) {
      tinyText += 1;
      label = `${label} [tiny print you can barely make out]`;
    }
    lines.push(`[${elementNumber}] ${label}`);
    clickable.set(elementNumber, el.id);
    // A card is a control too: one whose box the bottom edge cuts shows her only the words above the edge.
    const ownWords = seenWords(el);
    const elBottom = el.rect ? el.rect.y + el.rect.h : null;
    if (ownWords && elBottom !== null && screenHeight > 0 && el.rect.y < screenHeight) {
      if (!windowEdgeAt && screenLimited && elBottom > screenHeight) windowEdgeAt = firstWords(ownWords);
      else if (elBottom <= screenHeight && elBottom > lastBottom) [lastOnScreen, lastBottom] = [firstWords(ownWords), elBottom];
    }
  }

  // Her screen edge is a fact about her window, said outside the page's own words so it is never read as the site's.
  if (windowEdgeAt)
    lines.push(`[Your window ends partway through "${windowEdgeAt}". The page goes on below; that is your screen edge, not the site.]`);
  // The edge between two things is an edge too: a card whose title was the last line on her screen, its amount and
  // reason just below, read as a card with neither (Raise Buddy re-visit 24, run 20261012-155420-f19b, three filings).
  else if (screenLimited && goesOnBelow && lastOnScreen && !truncated)
    lines.push(`[Your window ends after "${lastOnScreen}". The page goes on below; that is your screen edge, not the site.]`);

  return { text: lines.join("\n"), clickable, stats: { tinyText, overHead, wordsShown, wordsTotal, truncated, readBlocks } };
}
