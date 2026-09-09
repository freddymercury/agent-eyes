const BRIDGE_URL = "http://localhost:8765/context";

// ---- full page / selection capture (unchanged behavior) ----

function extractPageContent() {
  const selection = window.getSelection().toString().trim();
  const text = selection.length > 0 ? selection : document.body.innerText;
  return {
    title: document.title,
    url: location.href,
    usedSelection: selection.length > 0,
    text: text.slice(0, 200000)
  };
}

// ---- element picker: hover to highlight, click to capture ----
// Injected on demand. Talks back to the background script via
// chrome.runtime.sendMessage since executeScript can't return values
// from an interactive/async flow like this.

function startElementPicker(mode) {
  if (window.__agenteyesPickerActive) return;
  window.__agenteyesPickerActive = true;

  const overlay = document.createElement("div");
  overlay.style.cssText =
    "position:fixed;pointer-events:none;z-index:2147483647;" +
    "border:2px solid #4FD8C4;background:rgba(79,216,196,0.15);" +
    "display:none;box-sizing:border-box;";
  document.documentElement.appendChild(overlay);

  const label = document.createElement("div");
  label.style.cssText =
    "position:fixed;pointer-events:none;z-index:2147483647;" +
    "background:#12141A;color:#4FD8C4;font:11px monospace;" +
    "padding:2px 6px;border-radius:4px;display:none;white-space:nowrap;";
  document.documentElement.appendChild(label);

  let currentEl = null;

  function describeEl(el) {
    const cls =
      typeof el.className === "string" && el.className.trim()
        ? "." + el.className.trim().split(/\s+/).join(".")
        : "";
    const id = el.id ? "#" + el.id : "";
    return el.tagName.toLowerCase() + id + cls;
  }

  function onMove(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === currentEl || el === overlay || el === label) return;
    currentEl = el;
    const r = el.getBoundingClientRect();
    overlay.style.display = "block";
    overlay.style.left = r.left + "px";
    overlay.style.top = r.top + "px";
    overlay.style.width = r.width + "px";
    overlay.style.height = r.height + "px";
    label.style.display = "block";
    label.style.left = r.left + "px";
    label.style.top = Math.max(0, r.top - 20) + "px";
    label.textContent = describeEl(el);
  }

  function cleanup() {
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
    label.remove();
    window.__agenteyesPickerActive = false;
  }

  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    if (currentEl && mode === "watch") {
      // Register a repeating watcher instead of sending once. Ask for a label
      // so several watchers on the same page stay tellable apart.
      const suggested = describeEl(currentEl).slice(0, 40);
      const label = window.prompt("Label for this watcher:", suggested) || suggested;
      // Optional on purpose: a watchpoint with no expectation observes without
      // asserting, and should not be forced into a claim the user has not made.
      const exp = (
        window.prompt(
          "Expectation for \"" + label + "\"?\n\n" +
            "  changes  - this must move when the action runs\n" +
            "  stable   - this must NOT move\n" +
            "  (blank)  - just observe\n",
          ""
        ) || ""
      ).trim().toLowerCase();
      const expectation = exp === "changes" || exp === "stable" ? exp : null;
      const modes = (
        window.prompt(
          "Watch which aspects? (comma separated)\n\n" +
            "  text, structure, attributes, state\n",
          "text"
        ) || "text"
      )
        .split(",")
        .map((m) => m.trim().toLowerCase())
        .filter((m) => ["text", "structure", "attributes", "state"].indexOf(m) >= 0);
      const added =
        window.__agentEyes && window.__agentEyes.add(currentEl, label, expectation, modes);
      chrome.runtime.sendMessage({ type: "agenteyes-watcher-added", data: added });
      cleanup();
      return;
    }
    if (currentEl) {
      const attrs = {};
      for (const a of currentEl.attributes) attrs[a.name] = a.value;
      chrome.runtime.sendMessage({
        type: "agenteyes-element-picked",
        data: {
          title: document.title,
          url: location.href,
          elementPicked: true,
          tag: currentEl.tagName.toLowerCase(),
          attrs,
          text: (currentEl.innerText || "").slice(0, 20000),
          outerHTML: currentEl.outerHTML.slice(0, 20000)
        }
      });
    }
    cleanup();
  }

  function onKey(e) {
    if (e.key === "Escape") cleanup();
  }

  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKey, true);
}

// ---- surface discovery: inventory what is interactive on the page ----
//
// Evidence, not truth. Frameworks delegate handlers at a root node, so
// "has a listener" is neither necessary nor sufficient for "is interactive" —
// and addEventListener registrations are invisible to a content script anyway.
// We combine semantic, accessibility, focusability and styling signals, and
// report which ones fired so a low-confidence entry can be judged rather than
// silently trusted.

function scanSurface(maxNodes) {
  const started = Date.now();
  const stats = {
    nodesVisited: 0,
    actionsFound: 0,
    durationMs: 0,
    truncated: false,
    shadowRootsTraversed: 0,
    iframesSkipped: 0
  };

  const NATIVE = {
    BUTTON: "activate",
    A: "navigate",
    SELECT: "select",
    TEXTAREA: "input",
    SUMMARY: "toggle",
    OPTION: "select"
  };
  const ARIA_KIND = {
    button: "activate",
    link: "navigate",
    menuitem: "activate",
    tab: "select",
    checkbox: "toggle",
    radio: "select",
    switch: "toggle",
    option: "select",
    combobox: "select",
    textbox: "input",
    searchbox: "input",
    slider: "input",
    menuitemcheckbox: "toggle",
    menuitemradio: "select"
  };
  const INPUT_KIND = {
    submit: "submit",
    button: "activate",
    reset: "activate",
    checkbox: "toggle",
    radio: "select",
    file: "input"
  };

  // ---- identity -----------------------------------------------------------
  //
  // An id has to survive a release, so it is built from semantics, never from
  // CSS classes. Filtering "generated" classes would mean a new heuristic per
  // styling framework (Tailwind utilities, CSS-modules hashes,
  // styled-components) and being wrong is silent — so classes are simply never
  // consulted.

  const IMPLICIT_ROLE = {
    BUTTON: "button", A: "link", INPUT: "textbox", SELECT: "combobox",
    TEXTAREA: "textbox", SUMMARY: "button", OPTION: "option", FORM: "form",
    NAV: "navigation", MAIN: "main", HEADER: "banner", FOOTER: "contentinfo",
    ASIDE: "complementary", SECTION: "region", ARTICLE: "article",
    UL: "list", OL: "list", LI: "listitem", TABLE: "table", DIALOG: "dialog"
  };

  function roleOf(el) {
    const explicit = (el.getAttribute("role") || "").toLowerCase();
    if (explicit) return explicit;
    if (el.tagName === "INPUT") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (t === "submit" || t === "button" || t === "reset") return "button";
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      return "textbox";
    }
    return IMPLICIT_ROLE[el.tagName] || "";
  }

  // Counts and dates churn constantly without the capability changing, so
  // "Cart (3)" and "Cart (4)" must normalize to the same name.
  function normalizeLabel(text) {
    return (text || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      // Only counts and badges are volatile — "Cart (3)" becoming "Cart (4)"
      // is not a capability change. Blanket digit replacement was wrong: it
      // collapsed Amazon's "Under $50" and "Under $100" into one key, so
      // genuinely different filters were separated only by position.
      .replace(/[([]\s*\d[\d,.\skmb+]*\s*[)\]]/gi, "(N)")
      .replace(/[\u2018\u2019\u201c\u201d]/g, "'")
      // Unicode-aware: an ASCII-only class silently empties every label on a
      // non-English UI, sending the whole page to positional identity, and
      // mangles accented Latin ("Café" -> "caf").
      .replace(/[^\p{L}\p{N}'\- ]/gu, "")
      .trim();
  }

  /**
   * Keep keys short without letting truncation invent collisions.
   *
   * Long labels that share a prefix — commit messages, article titles, file
   * paths — are common, and slicing to 60 characters silently merges them into
   * one key that ordinals then have to separate. Keeping a suffix hash means
   * the key stays readable and still distinguishes them.
   */
  function boundedName(name) {
    if (name.length <= 60) return name;
    return name.slice(0, 60) + "+" + shortHash(name);
  }

  /** Chain of meaningful ancestor roles — survives wrapper divs being added. */
  function roleAncestorPath(el) {
    const parts = [];
    let n = el.parentElement;
    while (n && parts.length < 5) {
      const r = roleOf(n);
      if (r && r !== "listitem") parts.unshift(r);
      n = n.parentElement;
    }
    return parts.join(">");
  }

  // Structural signatures, cached per element. Recomputing these while walking
  // ancestors for every action is quadratic on a large page.
  const sigCache = new WeakMap();

  /**
   * A shape fingerprint for an element: its tag plus the tag sequence of its
   * descendants to a bounded depth.
   *
   * Deliberately ignores classes and text. Two product cards differ in content
   * and styling but share a shape, and class names are exactly the thing that
   * cannot be relied on — the same reason they are never used for identity.
   */
  function structuralSignature(el, depth) {
    if (depth === undefined) depth = 3;
    const cached = sigCache.get(el);
    if (cached !== undefined) return cached;
    const parts = [el.tagName];
    let count = 0;
    const walk = (node, d) => {
      if (d > depth || count > 40) return;
      for (const c of node.children) {
        parts.push(d + c.tagName);
        count++;
        walk(c, d + 1);
      }
    };
    walk(el, 1);
    const sig = parts.join(",");
    sigCache.set(el, sig);
    return sig;
  }

  /**
   * The nearest ancestor that is one of several structurally identical siblings.
   *
   * This is what a "row" or "card" actually is, independent of markup: the
   * Yahoo draft client uses table rows, YouTube comments use custom elements,
   * and commerce grids use plain divs. Keying off li/tr/article recognises only
   * the first, which is why repeated controls in the other two stayed
   * position-dependent.
   */
  function repeatedUnitAncestor(el) {
    let n = el.parentElement;
    for (let hops = 0; n && hops < 8; hops++, n = n.parentElement) {
      const parent = n.parentElement;
      if (!parent || parent.children.length < 3) continue;
      const sig = structuralSignature(n);
      let same = 0;
      for (const c of parent.children) {
        if (structuralSignature(c) === sig && ++same >= 3) break;
      }
      // Three is the smallest count that distinguishes a repeated unit from a
      // coincidental pair of similar siblings.
      if (same >= 3) return n;
    }
    return null;
  }

  /**
   * Nearest enclosing container that has a distinctive name of its own.
   *
   * Product grids and feeds repeat identical controls — "Add to cart" once per
   * card — and ordinals alone then carry the identity, which churns whenever
   * the list reorders. The card usually has a heading or accessible name that
   * does not move with position, so scoping to it turns a fragile ordinal into
   * a stable key.
   */
  function containerName(el) {
    let n = el.parentElement;
    // Semantic containers are checked first because they are unambiguous when
    // present; the structural fallback below catches everything else.
    // Anything inside the control we are identifying is its own label, not the
    // container's — a row of "Draft" buttons would otherwise all resolve to
    // "draft" and stay indistinguishable.
    const isSelf = (c) => c === el || el.contains(c);
    let hops = 0;
    while (n && hops < 6) {
      hops++;
      const role = roleOf(n);
      if (role === "listitem" || role === "article" || role === "row" || n.tagName === "LI" ||
          n.tagName === "ARTICLE" || n.tagName === "TR") {
        // Prefer an explicit label, else the container's first heading or link.
        const own = n.getAttribute("aria-label");
        if (own && own.trim()) return normalizeLabel(own);
        const anchor = n.querySelector("h1,h2,h3,h4,[role=heading],a[href]");
        if (anchor && !isSelf(anchor)) {
          const t = normalizeLabel(anchor.innerText || anchor.getAttribute("aria-label") || "");
          if (t) return t.slice(0, 40);
        }
        // Cards have headings; data-table rows do not. The distinguishing text
        // is just a cell's contents — a player name, an order number — so fall
        // back to the first leaf with short, distinctive text. Leaves only, and
        // bounded, to avoid picking up a whole row of volatile statistics.
        const leaves = n.querySelectorAll("*");
        for (let i = 0; i < leaves.length && i < 60; i++) {
          const c = leaves[i];
          if (c.children.length || isSelf(c)) continue;
          const t = normalizeLabel(c.innerText || c.textContent || "");
          if (t.length >= 2 && t.length <= 40) return t;
        }
        return "";
      }
      n = n.parentElement;
    }

    // No semantic container. Fall back to a structurally repeated ancestor,
    // which is what a row or card is on a page that does not use li or tr.
    const unit = repeatedUnitAncestor(el);
    if (unit) {
      const own = unit.getAttribute && unit.getAttribute("aria-label");
      if (own && own.trim()) return normalizeLabel(own).slice(0, 40);
      const leaves = unit.querySelectorAll("*");
      for (let i = 0; i < leaves.length && i < 60; i++) {
        const c = leaves[i];
        if (c.children.length || isSelf(c)) continue;
        const t = normalizeLabel(c.innerText || c.textContent || "");
        if (t.length >= 2 && t.length <= 40) return t;
      }
    }
    return "";
  }

  const LANDMARK_WEIGHT = {
    main: 1.0, search: 0.9, form: 0.9, region: 0.9,
    navigation: 0.5, banner: 0.4, complementary: 0.3, contentinfo: 0.1
  };

  /**
   * Where the page says this element lives.
   *
   * Reports the *innermost* landmark, which is the specific answer — a link in
   * a <nav> inside a <header> is in navigation, not merely in the banner.
   *
   * Weight, though, is the *least* prominent landmark on the chain: a region
   * inside a footer is still in the footer, and taking the innermost weight
   * alone would promote it to 0.9.
   */
  function landmarkOf(el) {
    let innermost = "";
    let weight = null;
    for (let n = el.parentElement; n; n = n.parentElement) {
      const r = roleOf(n);
      if (r in LANDMARK_WEIGHT) {
        if (!innermost) innermost = r;
        weight = weight === null ? LANDMARK_WEIGHT[r] : Math.min(weight, LANDMARK_WEIGHT[r]);
      }
    }
    return { landmark: innermost, weight };
  }

  // Labels that carry no task-specific meaning wherever they appear.
  const GENERIC_LABELS = new Set([
    "learn more", "click here", "read more", "more", "home", "terms", "privacy",
    "contact", "about", "help", "docs", "support", "status", "security",
    "cookie policy", "manage cookies", "skip to content", "sign in", "log in"
  ]);

  /**
   * How structurally prominent an action is. Deliberately separate from
   * confidence, which answers whether something is interactive — a footer link
   * genuinely is, and should keep its high confidence while ranking low.
   */
  function prominenceOf(el, name, kind) {
    const { landmark, weight } = landmarkOf(el);
    // No landmark sits between navigation and region: most pages do not mark up
    // their main content, and assuming the worst would bury everything.
    let score = weight === null ? 0.7 : weight;
    if (GENERIC_LABELS.has(name)) score *= 0.35;
    if (kind === "submit" || kind === "input") score *= 1.15;
    return { landmark, prominence: Math.min(1, Math.round(score * 100) / 100) };
  }

  function testIdOf(el) {
    for (const a of ["data-testid", "data-test-id", "data-test", "data-cy", "data-qa"]) {
      const v = el.getAttribute(a);
      if (v && v.trim()) return v.trim();
    }
    return null;
  }

  function shortHash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  function domPath(el) {
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1 && parts.length < 12) {
      let p = n.tagName.toLowerCase();
      if (n.id) {
        parts.unshift(p + "#" + n.id);
        break;
      }
      const parent = n.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter((c) => c.tagName === n.tagName);
        if (sibs.length > 1) p += ":nth-of-type(" + (sibs.indexOf(n) + 1) + ")";
      }
      parts.unshift(p);
      n = n.parentElement;
    }
    return parts.join(" > ");
  }

  // Approximation of the accessible name. The real algorithm is far larger,
  // and the full accessibility tree is not reachable from an extension without
  // chrome.debugger, which shows a "being debugged" banner.
  function accessibleName(el) {
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const parts = labelledby
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((n) => (n.innerText || "").trim());
      if (parts.length) return parts.join(" ").trim();
    }
    if (el.id) {
      const lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (lab && lab.innerText.trim()) return lab.innerText.trim();
    }
    const closestLabel = el.closest && el.closest("label");
    if (closestLabel && closestLabel.innerText.trim()) return closestLabel.innerText.trim();
    for (const attr of ["title", "placeholder", "alt", "value", "name"]) {
      const v = el.getAttribute && el.getAttribute(attr);
      if (v && v.trim()) return v.trim();
    }
    const text = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
    return text.slice(0, 80);
  }

  function isDisabled(el) {
    if (el.disabled === true) return true;
    if (el.getAttribute("aria-disabled") === "true") return true;
    return false;
  }

  function classify(el) {
    const tag = el.tagName;
    const role = (el.getAttribute("role") || "").toLowerCase();
    const evidence = {};
    let kind = null;

    if (tag === "INPUT") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (t !== "hidden") {
        evidence.nativeDom = true;
        kind = INPUT_KIND[t] || "input";
      }
    } else if (tag === "A") {
      if (el.hasAttribute("href")) {
        evidence.nativeDom = true;
        kind = "navigate";
      }
    } else if (NATIVE[tag]) {
      evidence.nativeDom = true;
      kind = NATIVE[tag];
    } else if (tag === "FORM") {
      return null; // the submit control is the action, not the form
    }

    if (role && ARIA_KIND[role]) {
      evidence.accessibility = true;
      kind = kind || ARIA_KIND[role];
    }

    if (el.isContentEditable) {
      evidence.nativeDom = true;
      kind = kind || "input";
    }

    const tabindex = el.getAttribute("tabindex");
    if (tabindex !== null && Number(tabindex) >= 0) evidence.focusable = true;

    for (const a of ["onclick", "onchange", "onsubmit", "oninput"]) {
      if (el.hasAttribute(a)) {
        evidence.inlineHandler = true;
        kind = kind || (a === "onsubmit" ? "submit" : "activate");
      }
    }

    if (!kind && (evidence.focusable || evidence.inlineHandler)) kind = "activate";

    if (!kind) {
      // Last resort: styled as clickable. Weak on its own, and common on
      // decorative elements, so it only qualifies with visible text.
      const cursor = getComputedStyle(el).cursor;
      const label = (el.innerText || "").trim();
      if (cursor === "pointer" && label && label.length < 120) {
        evidence.pointerCursor = true;
        kind = "activate";
      }
    }

    if (!kind) return null;

    // Weighted so that a single weak signal cannot look confident.
    let confidence = 0;
    if (evidence.nativeDom) confidence += 0.75;
    if (evidence.accessibility) confidence += 0.55;
    if (evidence.inlineHandler) confidence += 0.35;
    if (evidence.focusable) confidence += 0.2;
    if (evidence.pointerCursor) confidence += 0.15;
    confidence = Math.min(1, Math.round(confidence * 100) / 100);

    return { kind, evidence, confidence, role };
  }

  function visible(el) {
    if (!el.getClientRects || el.getClientRects().length === 0) return false;
    const st = getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none";
  }

  // Which testids actually identify a single element. An app-provided id that
  // appears once is the most durable anchor there is and should survive a
  // rename; one repeated per row identifies a component, not an instance, and
  // needs the name to separate instances. Deciding per testid gets both.
  const testIdCounts = new Map();
  for (const el of document.querySelectorAll(
    "[data-testid],[data-test-id],[data-test],[data-cy],[data-qa]"
  )) {
    const v = testIdOf(el);
    if (v) testIdCounts.set(v, (testIdCounts.get(v) || 0) + 1);
  }

  const actions = [];
  const queue = [document.body];
  // Elements already recorded, so a descendant that is merely styled clickable
  // is recognised as part of the same control rather than a second action.
  // GitHub's nav renders the label in a <span> inside the <a>; both otherwise
  // qualify, and the inventory doubles.
  const claimed = new Set();
  // Disambiguates several controls that are genuinely identical in semantics
  // ("Edit" three times in the same list).
  const ordinals = new Map();

  while (queue.length) {
    const node = queue.shift();
    if (!node) continue;
    if (stats.nodesVisited >= maxNodes) {
      stats.truncated = true;
      break;
    }
    stats.nodesVisited++;

    if (node.tagName === "IFRAME" || node.tagName === "FRAME") {
      // Cross-document scanning needs its own injection and a security story;
      // out of scope rather than silently partial.
      stats.iframesSkipped++;
      continue;
    }

    if (node.nodeType === 1 && node !== document.body && visible(node)) {
      let c = classify(node);
      if (c && c.evidence.pointerCursor && !c.evidence.nativeDom && !c.evidence.accessibility) {
        for (let p = node.parentElement; p; p = p.parentElement) {
          if (claimed.has(p)) {
            c = null;
            break;
          }
        }
      }
      if (c) {
        claimed.add(node);
        const testId = testIdOf(node);
        const role = roleOf(node);
        const name = boundedName(normalizeLabel(accessibleName(node)));
        const path = roleAncestorPath(node);

        const container = containerName(node);
        const prom = prominenceOf(node, name, c.kind);
        let identityStrategy;
        let identityKey;
        if (testId) {
          identityStrategy = "testid";
          // A testid is often per-component rather than per-instance —
          // commit-row-item on every commit, testid:reply on every post — so
          // keep the name alongside it. Without this the one thing that would
          // separate them is thrown away in favour of position.
          const unique = (testIdCounts.get(testId) || 0) <= 1;
          identityKey = "testid:" + testId + (unique || !name ? "" : "|" + name);
        } else if (name || role) {
          identityStrategy = name ? "semantic" : "positional";
          identityKey = [role, name, path].join("|");
        } else {
          // Nothing semantic to hold on to; the id will churn and says so.
          identityStrategy = "positional";
          identityKey = domPath(node);
        }

        // Scope by container before counting ordinals, so repeated controls in
        // distinct cards stop colliding in the first place.
        if (container) identityKey = identityKey + "@" + container;

        const seen = (ordinals.get(identityKey) || 0);
        ordinals.set(identityKey, seen + 1);
        // "~" and not "#": normalizeLabel already emits "#"-free text, but the
        // separator must be one that can never occur inside a key.
        const withOrdinal = seen === 0 ? identityKey : identityKey + "~" + seen;
        // A data-testid is not necessarily unique — X reuses testid:reply on
        // every post in the feed. Such an id is distinguished only by position
        // and is no more durable than a positional one, so say so rather than
        // letting the strategy label imply a durability it does not have.
        const ordinalDisambiguated = seen > 0;

        actions.push({
          id: shortHash(withOrdinal),
          identityStrategy,
          ordinalDisambiguated,
          landmark: prom.landmark || undefined,
          prominence: prom.prominence,
          identityKey: withOrdinal,
          // Collapse whitespace: a commit row's innerText carries the whole
          // message body, and a label spanning lines is unreadable in any report.
          label: (accessibleName(node) || node.tagName.toLowerCase()).replace(/\s+/g, " ").trim(),
          kind: c.kind,
          evidence: c.evidence,
          enabled: !isDisabled(node),
          confidence: c.confidence,
          domExposure: {
            domPath: domPath(node),
            roleAncestorPath: path,
            tagName: node.tagName.toLowerCase(),
            role: c.role || undefined,
            accessibleName: accessibleName(node) || undefined
          }
        });
      }
    }

    if (node.shadowRoot) {
      stats.shadowRootsTraversed++;
      for (const child of node.shadowRoot.children) queue.push(child);
    }
    if (node.children) for (const child of node.children) queue.push(child);
  }

  stats.actionsFound = actions.length;
  stats.durationMs = Date.now() - started;

  return {
    title: document.title,
    url: location.href,
    kind: "surface",
    actions,
    stats,
    capturedAt: new Date().toISOString()
  };
}

// ---- watch kit: multiple named element watchers, each diffed independently ----
//
// Installed once per tab. Keeps a registry on window so it survives service
// worker eviction — the interval must live in the page, not the worker, since
// MV3 workers are evicted when idle and chrome.alarms floors at 30s.

function installWatchKit(bridgeUrl, intervalMs) {
  if (window.__agentEyes) return true;

  // A selector we can re-query every tick. Frameworks replace nodes on
  // re-render, so holding a raw element reference goes stale; the path
  // survives that, and we fall back to the original node if it doesn't match.
  function cssPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 12) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift(part + "#" + CSS.escape(node.id));
        break;
      }
      const parent = node.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (sibs.length > 1) part += ":nth-of-type(" + (sibs.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  function hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return h;
  }

  // Attributes worth watching. Deliberately not "all attributes": frameworks
  // rewrite class and style constantly, and a watchpoint that fires on every
  // re-render asserts nothing.
  const WATCHED_ATTRS = ["href", "src", "value", "title", "alt", "placeholder", "type", "name"];
  const STATE_ATTRS = [
    "aria-expanded", "aria-checked", "aria-selected", "aria-disabled",
    "aria-pressed", "aria-current", "aria-invalid", "aria-busy", "disabled", "open", "checked"
  ];

  /**
   * Observe one element four ways, so a report can say *what* moved rather
   * than only that something did.
   *
   *   text       — what it says
   *   structure  — the shape of its subtree, ignoring content
   *   attributes — meaningful attributes, ignoring styling
   *   state      — the ARIA and form state that expresses interactivity
   */
  function observeElement(el) {
    const text = el.innerText || "";

    const shape = [];
    const walk = (node, depth) => {
      if (depth > 8 || shape.length > 4000) return;
      for (const c of node.children) {
        shape.push(depth + ":" + c.tagName + ":" + (c.getAttribute("role") || ""));
        walk(c, depth + 1);
      }
    };
    walk(el, 0);

    const attrs = [];
    const collectAttrs = (node, depth) => {
      if (depth > 6) return;
      for (const a of WATCHED_ATTRS) {
        if (node.hasAttribute && node.hasAttribute(a)) attrs.push(a + "=" + node.getAttribute(a));
      }
      for (const c of node.children) collectAttrs(c, depth + 1);
    };
    collectAttrs(el, 0);

    const state = [];
    const collectState = (node, depth) => {
      if (depth > 6) return;
      for (const a of STATE_ATTRS) {
        if (node.hasAttribute && node.hasAttribute(a)) state.push(a + "=" + node.getAttribute(a));
      }
      if (node.tagName === "INPUT" || node.tagName === "SELECT" || node.tagName === "TEXTAREA") {
        state.push(node.tagName + ".value=" + (node.value || ""));
        if (node.checked !== undefined) state.push(node.tagName + ".checked=" + node.checked);
      }
      for (const c of node.children) collectState(c, depth + 1);
    };
    collectState(el, 0);

    return {
      text: text.slice(0, 200000),
      hashes: {
        text: String(hash(text)),
        structure: String(hash(shape.join("|"))),
        attributes: String(hash(attrs.join("|"))),
        state: String(hash(state.join("|")))
      }
    };
  }

  const ROLE_TAGS = {
    button: "button", link: "a[href]", textbox: "input,textarea",
    combobox: "select", list: "ul,ol", table: "table", region: "section", main: "main"
  };
  const roleTagHint = (r) => ROLE_TAGS[r] || "*";

  function implicitRole(el) {
    if (el.tagName === "BUTTON") return "button";
    if (el.tagName === "A" && el.hasAttribute("href")) return "link";
    if (el.tagName === "TABLE") return "table";
    if (el.tagName === "MAIN") return "main";
    return "";
  }

  function watchAccessibleName(el) {
    const aria = el.getAttribute && el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim().slice(0, 80);
    const t = (el.innerText || "").trim().replace(/\s+/g, " ");
    return t.slice(0, 80);
  }

  const registry = {
    bridgeUrl,
    intervalMs,
    nextId: 1,
    watchers: new Map(),

    add(el, label, expectation, observe) {
      const id = "w" + registry.nextId++;
      const selector = cssPath(el);
      // Record a semantic target too. A CSS path breaks the moment the page
      // re-wraps the element; role plus accessible name usually survives it.
      const role = (el.getAttribute("role") || "").toLowerCase() || implicitRole(el);
      const accessibleName = watchAccessibleName(el);
      const w = {
        id,
        label: label || (el.tagName.toLowerCase() + (el.id ? "#" + el.id : "")),
        selector,
        role,
        accessibleName,
        expectation: expectation || null,
        observe: observe && observe.length ? observe : ["text"],
        el,
        last: null,
        sent: 0,
        failed: 0,
        // Monotonic per watcher, so a consumer can tell a genuine change from
        // an identical re-send after a restart.
        revision: 0,
        timer: null
      };
      w.timer = setInterval(() => registry.tick(id), registry.intervalMs);
      registry.watchers.set(id, w);
      registry.tick(id);
      return { id: w.id, label: w.label, selector: w.selector, expectation: w.expectation, observe: w.observe };
    },

    remove(id) {
      const w = registry.watchers.get(id);
      if (!w) return false;
      clearInterval(w.timer);
      registry.watchers.delete(id);
      // Tombstone, so consumers retire the watcher immediately instead of
      // waiting for it to look stale — those are different situations.
      registry.tombstone(w);
      return true;
    },

    tombstone(w) {
      try {
        fetch(registry.bridgeUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            watchId: w.id,
            label: w.label,
            removed: true,
            capturedAt: new Date().toISOString()
          })
        });
      } catch (err) {
        /* removal is best-effort; the watcher is already stopped */
      }
    },

    clear() {
      for (const id of Array.from(registry.watchers.keys())) registry.remove(id);
      return true;
    },

    list() {
      return Array.from(registry.watchers.values()).map((w) => ({
        id: w.id,
        label: w.label,
        selector: w.selector,
        expectation: w.expectation,
        observe: w.observe,
        sent: w.sent,
        failed: w.failed,
        alive: !!registry.resolve(w)
      }));
    },

    resolve(w) {
      let el = null;
      try {
        el = w.selector ? document.querySelector(w.selector) : null;
      } catch (err) {
        el = null;
      }
      if (!el && w.el && w.el.isConnected) el = w.el;
      // Last resort: find it again by what it is rather than where it was.
      // A re-render moves an element without changing its role or its name.
      if (!el && w.accessibleName) {
        const candidates = document.querySelectorAll(
          w.role ? `[role="${w.role}"], ${roleTagHint(w.role)}` : "*"
        );
        for (const c of candidates) {
          if (watchAccessibleName(c) === w.accessibleName) {
            el = c;
            break;
          }
        }
      }
      return el;
    },

    async tick(id) {
      const w = registry.watchers.get(id);
      if (!w) return;
      const el = registry.resolve(w);
      if (!el) {
        // The element was re-rendered away. Report it once rather than going
        // quiet, which is indistinguishable from a page that just isn't changing.
        if (w.last !== null) {
          w.last = null;
          registry.report(w, "", false, {});
        }
        return;
      }
      const obs = observeElement(el);
      // Only the aspects this watchpoint observes decide whether it changed;
      // watching text should not fire because a class attribute moved.
      const key = (w.observe || ["text"]).map((m) => obs.hashes[m]).join("|");
      if (key === w.last) return;
      w.last = key;
      await registry.report(w, obs.text, true, obs.hashes);
    },

    async report(w, text, alive, hashes) {
      w.revision++;
      try {
        const res = await fetch(registry.bridgeUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: document.title,
            url: location.href,
            autoWatch: true,
            watchId: w.id,
            label: w.label,
            elementPicked: true,
            selector: w.selector,
            alive,
            revision: w.revision,
            role: w.role,
            accessibleName: w.accessibleName,
            expectation: w.expectation,
            observe: w.observe,
            hashes: hashes || {},
            text: text.slice(0, 200000),
            capturedAt: new Date().toISOString()
          })
        });
        res.ok ? w.sent++ : w.failed++;
      } catch (err) {
        w.failed++;
      }
    }
  };

  window.__agentEyes = registry;
  return true;
}

function watchKitCall(method, arg) {
  const r = window.__agentEyes;
  if (!r) return { ok: false, error: "watch kit not installed" };
  if (method === "list") return { ok: true, watchers: r.list() };
  if (method === "remove") return { ok: r.remove(arg), watchers: r.list() };
  if (method === "clear") return { ok: r.clear(), watchers: [] };
  return { ok: false, error: "unknown method " + method };
}

// ---- shared send + badge feedback ----

function flashBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 1200);
}

async function postToBridge(payload) {
  try {
    const res = await fetch(BRIDGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    flashBadge(res.ok ? "\u2713" : "!", res.ok ? "#4FD8C4" : "#E5484D");
    return { ok: res.ok };
  } catch (err) {
    // Most common cause: the local server isn't running.
    console.error("AgentEyes: failed to send —", err);
    flashBadge("!", "#E5484D");
    return { ok: false, error: String(err) };
  }
}

async function sendCurrentTab(tabId) {
  const tab = tabId
    ? { id: tabId }
    : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!tab || !tab.id) {
    flashBadge("!", "#E5484D");
    return { ok: false };
  }

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: extractPageContent
  });

  return postToBridge({ ...result, capturedAt: new Date().toISOString() });
}

async function activatePicker(tabId) {
  const tab = tabId
    ? { id: tabId }
    : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!tab || !tab.id) {
    flashBadge("!", "#E5484D");
    return;
  }

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: startElementPicker
  });
}

const WATCH_INTERVAL_MS = 5000;
// Bounded so a pathological page degrades to a truncated scan rather than
// hanging the tab. Reported in stats.truncated when hit.
const SCAN_MAX_NODES = 20000;

/**
 * A default name derived from where the snapshot was taken.
 *
 * document.title is a poor default — it is decorated with unread counts and
 * notification badges ("(2) Home / X"), so two snapshots of the same page get
 * different names. Host plus the first path segments identifies the view, and
 * a timestamp keeps repeated snapshots of it distinct.
 */
function suggestSnapshotName(url) {
  let host = "page";
  let path = "";
  try {
    const u = new URL(url);
    host = u.hostname.replace(/^www\./, "");
    path = u.pathname;
  } catch (err) {
    /* fall through to defaults */
  }
  const slug = (str, max) =>
    str
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max);
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp =
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    "-" +
    pad(d.getHours()) +
    pad(d.getMinutes());
  const parts = [slug(host, 40)];
  const p = slug(path.split("/").filter(Boolean).slice(0, 3).join("-"), 40);
  if (p) parts.push(p);
  parts.push(stamp);
  return parts.join("-");
}

/**
 * Save the current surface as a named snapshot.
 *
 * Scans first rather than reusing the last scan: a snapshot named for a release
 * should describe the page as it is now, not whenever someone last pressed the
 * scan shortcut.
 */
async function saveSnapshot_(tabId, name, release) {
  const tab = await resolveTab(tabId);
  if (!tab) return { ok: false };
  const [{ result: scan }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: scanSurface,
    args: [SCAN_MAX_NODES]
  });
  const actions = (scan && scan.actions) || [];
  const rate = (n) => (actions.length ? Math.round((n / actions.length) * 1000) / 1000 : 0);
  const meta = {
    name,
    url: scan.url,
    title: scan.title,
    completeness: "dom-actions",
    health: {
      actions: actions.length,
      positionalRate: rate(actions.filter((a) => a.identityStrategy === "positional").length),
      ordinalRate: rate(actions.filter((a) => a.ordinalDisambiguated).length),
      lowConfidenceRate: rate(actions.filter((a) => a.confidence < 0.3).length),
      truncated: !!(scan.stats && scan.stats.truncated)
    },
    release
  };
  const snapshot = {
    schemaVersion: 1,
    id: "surface-" + Date.now(),
    context: { url: scan.url, title: scan.title, capturedAt: scan.capturedAt },
    completeness: "dom-actions",
    actions,
    webmcpTools: [],
    watchpoints: [],
    scanStats: scan.stats
  };
  try {
    const res = await fetch(BRIDGE_URL.replace("/context", "/snapshot"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ meta, snapshot })
    });
    const body = await res.json();
    flashBadge(res.ok ? "\u2713" : "!", res.ok ? "#4FD8C4" : "#E5484D");
    return {
      ok: res.ok,
      meta: body.meta,
      health: meta.health,
      path: body.path,
      url: body.url,
      fileUrl: body.fileUrl
    };
  } catch (err) {
    flashBadge("!", "#E5484D");
    return { ok: false, error: String(err) };
  }
}

/** Inventory the page's interactive surface and send it to the bridge. */
async function scanSurface_(tabId) {
  const tab = await resolveTab(tabId);
  if (!tab) return { ok: false };
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: scanSurface,
    args: [SCAN_MAX_NODES]
  });
  const res = await postToBridge(result);
  return { ok: res.ok, stats: result && result.stats };
}

async function resolveTab(tabId) {
  const tab = tabId
    ? { id: tabId }
    : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  return tab && tab.id ? tab : null;
}

async function ensureKit(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: installWatchKit,
    args: [BRIDGE_URL, WATCH_INTERVAL_MS]
  });
}

/** Start the picker in "watch" mode: the clicked element becomes a watcher. */
async function addWatchTarget(tabId) {
  const tab = await resolveTab(tabId);
  if (!tab) return { ok: false };
  await ensureKit(tab.id);
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: startElementPicker,
    args: ["watch"]
  });
  return { ok: true };
}

async function watchKit(tabId, method, arg) {
  const tab = await resolveTab(tabId);
  if (!tab) return { ok: false, watchers: [] };
  await ensureKit(tab.id);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: watchKitCall,
    args: [method, arg ?? null]
  });
  const n = result && result.watchers ? result.watchers.length : 0;
  chrome.action.setBadgeText({ text: n ? String(n) : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#4FD8C4" });
  return result || { ok: false, watchers: [] };
}

// ---- wiring ----

chrome.commands.onCommand.addListener((command) => {
  if (command === "send-page") sendCurrentTab();
  if (command === "pick-element") activatePicker();
  if (command === "toggle-watch") addWatchTarget();
  if (command === "scan-surface") scanSurface_();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "agenteyes-element-picked") {
    postToBridge({ ...message.data, capturedAt: new Date().toISOString() });
    return; // no response expected here — sender is the content script
  }

  if (message?.type === "agenteyes-popup-send-page") {
    sendCurrentTab().then((result) => sendResponse(result));
    return true; // keep the message channel open for the async response
  }

  if (message?.type === "agenteyes-watcher-added") {
    chrome.action.setBadgeText({ text: "\u25CF" });
    chrome.action.setBadgeBackgroundColor({ color: "#4FD8C4" });
    return;
  }

  if (message?.type === "agenteyes-popup-add-watch") {
    addWatchTarget().then((result) => sendResponse(result));
    return true;
  }

  if (message?.type === "agenteyes-popup-scan-surface") {
    scanSurface_().then((result) => sendResponse(result));
    return true;
  }

  if (message?.type === "agenteyes-popup-suggest-name") {
    resolveTab(null).then((tab) =>
      sendResponse({ suggestion: suggestSnapshotName(tab && tab.url ? tab.url : "") })
    );
    return true;
  }

  if (message?.type === "agenteyes-popup-save-snapshot") {
    saveSnapshot_(null, message.name, message.release).then((r) => sendResponse(r));
    return true;
  }

  if (message?.type === "agenteyes-popup-list-watch") {
    watchKit(null, "list").then((result) => sendResponse(result));
    return true;
  }

  if (message?.type === "agenteyes-popup-remove-watch") {
    watchKit(null, "remove", message.id).then((result) => sendResponse(result));
    return true;
  }

  if (message?.type === "agenteyes-popup-clear-watch") {
    watchKit(null, "clear").then((result) => sendResponse(result));
    return true;
  }

  if (message?.type === "agenteyes-popup-pick-element") {
    activatePicker().then(() => sendResponse({ ok: true }));
    return true;
  }
});

// Right-click menu — same two actions, available wherever your cursor is.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "agenteyes-send-page",
    title: "AgentEyes: send this page",
    contexts: ["all"]
  });
  chrome.contextMenus.create({
    id: "agenteyes-pick-element",
    title: "AgentEyes: pick an element\u2026",
    contexts: ["all"]
  });
  chrome.contextMenus.create({
    id: "agenteyes-toggle-watch",
    title: "AgentEyes: watch this element\u2026",
    contexts: ["all"]
  });
  chrome.contextMenus.create({
    id: "agenteyes-scan-surface",
    title: "AgentEyes: scan interactive surface",
    contexts: ["all"]
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === "agenteyes-send-page") sendCurrentTab(tab.id);
  if (info.menuItemId === "agenteyes-pick-element") activatePicker(tab.id);
  if (info.menuItemId === "agenteyes-toggle-watch") addWatchTarget(tab.id);
  if (info.menuItemId === "agenteyes-scan-surface") scanSurface_(tab.id);
});
