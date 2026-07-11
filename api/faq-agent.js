// ============================================================================
//  GRANTS PLUMBING AND HEATING - quoting assistant (SAMPLE)
//  Furness & South Lakes area. Gas Safe registered.
//  Boiler installation, boiler service/repair, central heating, plumbing.
//
//  - AI provider: OpenAI / Gemini - drives the ENGLISH conversation.
//  - Price is computed DETERMINISTICALLY in this backend (buildQuote).
//    The AI never does arithmetic - the total can never be miscalculated.
//  - When all answers are collected the AI emits <!--DATA:{...}-->.
//    We parse it, price it, log the lead, and return an itemised estimate
//    (shown as a RANGE) with a clear "confirmed before work begins" line.
// ============================================================================

// ---------------------------------------------------------------------------
//  PRICE MODEL (GBP, 2026) - single source of truth.
// ---------------------------------------------------------------------------
const MODEL = {
    // Boiler supply & installation (combi or system, incl. flue & controls)
    boilerInstall: {
        budget:  { low: 1400, high: 2200 }, // budget combi (Baxi, Ideal)
        mid:     { low: 2300, high: 3500 }, // mid-range (Worcester, Vaillant)
        premium: { low: 3500, high: 5500 }, // high-efficiency / system boiler
    },

    // Boiler service / repair
    boilerService: {
        service: { low: 75,  high: 120 }, // Gas Safe annual service + certificate
        repair:  { low: 120, high: 450 }, // breakdown (parts vary widely)
    },

    // Central heating
    heating: {
        cold_rads:   { low: 100, high: 250 }, // radiator bleed, balance & check
        power_flush: { low: 350, high: 600 }, // power flush (whole system)
        new_rads:    { low: 280, high: 500 }, // add one radiator (incl. supply & fit)
        other:       { low: 150, high: 400 }, // general heating diagnostic
    },

    // Plumbing - always a callout + the specific repair
    plumbingCallout: { low: 75,  high: 120 },
    plumbing: {
        leaking: { low: 120, high: 320 }, // leak (tap, pipe, joint)
        blocked: { low: 100, high: 250 }, // blocked drain or toilet
        toilet:  { low: 90,  high: 220 }, // toilet repair / replacement
        other:   { low: 100, high: 350 }, // general plumbing
    },

    // Gas safety certificate (CP12)
    gasSafeCert: {
        single:   { low: 65,  high: 90  }, // 1 appliance (standard boiler)
        multiple: { low: 90,  high: 180 }, // 2-5 appliances (HMO / commercial)
    },

    // Bathroom fitting
    bathroomFitting: {
        fixtures: { low: 600,  high: 1400 }, // fit customer-supplied suite only
        partial:  { low: 1500, high: 3500 }, // fixtures + tiling + minor replumb
        full:     { low: 3500, high: 7500 }, // full strip-out, replumb, tiling, all fixtures
    },

    commercialMult: 1.15,
};

const FLOW_LABEL = {
    boilerInstall:   "Boiler installation",
    boilerService:   "Boiler service / repair",
    heating:         "Heating issue",
    plumbing:        "Plumbing problem",
    gasSafeCert:     "Gas safety certificate (CP12)",
    bathroomFitting: "Bathroom fitting",
};

const CALENDLY = process.env.CALENDLY_URL || "https://calendly.com/pirint-milan/quoting-agent-sample";

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------
function formatGbp(n) {
    return "£" + Math.round(n).toLocaleString("en-GB");
}
const round25 = (n) => Math.round(n / 25) * 25;
const round50 = (n) => Math.round(n / 50) * 50;

function makeItemExplicit(label, low, high) {
    return { label, cost: Math.round((low + high) / 2), low: round25(low), high: round25(high) };
}

// ===========================================================================
//  SECURITY HELPERS
// ===========================================================================
function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function clientIp(req) {
    const xf = req.headers && (req.headers["x-forwarded-for"] || req.headers["x-real-ip"]);
    if (typeof xf === "string" && xf.trim()) return xf.split(",")[0].trim();
    return (req.socket && req.socket.remoteAddress) || "unknown";
}

const RL_BUCKETS = new Map();
function rateLimit(key, limit, windowMs) {
    const now = Date.now();
    let b = RL_BUCKETS.get(key);
    if (!b || now > b.resetAt) { b = { count: 0, resetAt: now + windowMs }; RL_BUCKETS.set(key, b); }
    b.count++;
    if (RL_BUCKETS.size > 10000) {
        for (const [k, v] of RL_BUCKETS) if (now > v.resetAt) RL_BUCKETS.delete(k);
    }
    return b.count <= limit ? { ok: true } : { ok: false, retryAfter: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) };
}

const RL_CHAT = { limit: Number(process.env.RL_CHAT_PER_MIN) || 30, windowMs: 60_000 };

const MAX_QUESTION_LEN = 2000;
const MAX_HISTORY_MSGS = 40;
const MAX_MSG_LEN = 8000;
const ALLOWED_ROLES = new Set(["user", "assistant", "model"]);

function validateChatInput(question, history) {
    if (question != null && (typeof question !== "string" || question.length > MAX_QUESTION_LEN)) return "Your message is too long.";
    if (history != null) {
        if (!Array.isArray(history) || history.length > MAX_HISTORY_MSGS) return "Invalid history.";
        for (const m of history) {
            if (!m || typeof m !== "object") return "Invalid history.";
            if (typeof m.content !== "string" || m.content.length > MAX_MSG_LEN) return "Invalid history.";
            if (!ALLOWED_ROLES.has(m.role)) return "Invalid history.";
        }
    }
    return null;
}

function applyCors(req, res) {
    const allow = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
    const origin = (req.headers && req.headers.origin) || "";
    let value = "*";
    if (allow.length) value = allow.includes(origin) ? origin : allow[0];
    res.setHeader("Access-Control-Allow-Origin", value);
    if (allow.length) res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
}

const validTier = (t) => (["budget", "mid", "premium"].includes(t) ? t : "mid");
const validProp = (p) => (p === "commercial" ? "commercial" : "domestic");

// ---------------------------------------------------------------------------
//  Quote builder - deterministic from customer answers
// ---------------------------------------------------------------------------
function finalize(items, meta = {}) {
    const total = items.reduce((s, i) => s + i.cost, 0);
    const low  = round50(items.reduce((s, i) => s + i.low,  0));
    const high = round50(items.reduce((s, i) => s + i.high, 0));
    return { items, total, low, high, ...meta };
}

function scaleItems(items, mult) {
    if (mult === 1) return items;
    return items.map((i) => ({
        label: i.label,
        cost:  Math.round(i.cost  * mult),
        low:   round25(i.low  * mult),
        high:  round25(i.high * mult),
    }));
}

function buildQuote(sel) {
    const pt   = sel && sel.projectType;
    const prop = validProp(sel.property);
    let items  = [];

    if (pt === "boilerInstall") {
        const tier = validTier(sel.tier);
        const b = MODEL.boilerInstall[tier];
        items.push(makeItemExplicit("Boiler supply & installation (incl. flue, controls & commissioning)", b.low, b.high));

    } else if (pt === "boilerService") {
        const jst = sel.jobSubType === "repair" ? "repair" : "service";
        if (jst === "service") {
            const s = MODEL.boilerService.service;
            items.push(makeItemExplicit("Gas Safe boiler service (inspection, clean & Gas Safe certificate)", s.low, s.high));
        } else {
            const s = MODEL.boilerService.service;
            const r = MODEL.boilerService.repair;
            items.push(makeItemExplicit("Diagnostic callout + first hour on site", s.low, s.high));
            items.push(makeItemExplicit("Estimated repair (parts + labour - varies by fault)", r.low, r.high));
        }

    } else if (pt === "heating") {
        const hi = ["cold_rads", "power_flush", "new_rads", "other"].includes(sel.heatingIssue) ? sel.heatingIssue : "other";
        const h  = MODEL.heating[hi];
        const label = {
            cold_rads:   "Radiator investigation, bleed & balance",
            power_flush: "Power flush (whole system clean - incl. chemical treatment)",
            new_rads:    "Radiator supply & installation (per radiator)",
            other:       "Heating diagnostic & repair (parts + labour)",
        }[hi];
        items.push(makeItemExplicit(label, h.low, h.high));

    } else if (pt === "gasSafeCert") {
        const cs = ["single", "multiple"].includes(sel.certScope) ? sel.certScope : "single";
        const g  = MODEL.gasSafeCert[cs];
        const label = cs === "multiple"
            ? "Gas safety inspection & CP12 certificate (multiple appliances / HMO)"
            : "Gas safety inspection & CP12 certificate (single appliance)";
        items.push(makeItemExplicit(label, g.low, g.high));

    } else if (pt === "bathroomFitting") {
        const bs = ["fixtures", "partial", "full"].includes(sel.bathroomScope) ? sel.bathroomScope : "partial";
        const b  = MODEL.bathroomFitting[bs];
        const label = {
            fixtures: "Fit customer-supplied bathroom suite (labour only)",
            partial:  "Partial bathroom refit (fixtures, tiling & plumbing alterations)",
            full:     "Full bathroom renovation (strip-out, replumb, tiling & all fixtures)",
        }[bs];
        items.push(makeItemExplicit(label, b.low, b.high));

    } else {
        // plumbing
        const pi = ["leaking", "blocked", "toilet", "other"].includes(sel.plumbingIssue) ? sel.plumbingIssue : "other";
        const c  = MODEL.plumbingCallout;
        const pr = MODEL.plumbing[pi];
        const label = {
            leaking: "Leak investigation & repair (tap, pipe or joint)",
            blocked: "Blocked drain or toilet clearance",
            toilet:  "Toilet repair or replacement",
            other:   "Plumbing diagnostic & repair",
        }[pi];
        items.push(makeItemExplicit("Callout + first hour on site", c.low, c.high));
        items.push(makeItemExplicit(label, pr.low, pr.high));
    }

    if (prop === "commercial") items = scaleItems(items, MODEL.commercialMult);

    return finalize(items, { projectType: pt });
}

// ---------------------------------------------------------------------------
//  FLOW CONFIG
// ---------------------------------------------------------------------------
function projectFields(pt) {
    switch (pt) {
        case "boilerInstall":   return ["property", "tier"];
        case "boilerService":   return ["property", "jobSubType"];
        case "heating":         return ["property", "heatingIssue"];
        case "plumbing":        return ["property", "plumbingIssue"];
        case "gasSafeCert":     return ["property", "certScope"];
        case "bathroomFitting": return ["property", "bathroomScope"];
        default:                return [];
    }
}

const TAIL_FIELDS    = ["timeline"];
const CONTACT_FIELDS = ["name", "email", "phone", "postcode"];

function fieldOrder(sel) {
    const pt = sel && sel.projectType;
    if (!pt) return ["projectType"];
    return ["projectType", ...projectFields(pt), ...TAIL_FIELDS, ...CONTACT_FIELDS];
}

function progressFields(sel) {
    const pt = sel && sel.projectType;
    if (!pt) return ["projectType"];
    return ["projectType", ...projectFields(pt), ...TAIL_FIELDS];
}

function isQuoteReady(s) {
    if (!s || typeof s !== "object" || !s.projectType) return false;
    const filled = (k) => s[k] != null && String(s[k]).trim() !== "";
    return fieldOrder(s).every(filled);
}

const CHIP_LABELS = {
    projectType:    ["Boiler service", "Boiler repair", "Bathroom fitting", "Gas safety certificate (CP12)", "New boiler (install / replace)", "Heating issue (radiators, pipes)", "Plumbing problem (leak, drain, tap)"],
    property:       ["Domestic (home)", "Commercial (business)", "Not sure"],
    tier:           ["Budget-friendly", "Mid-range", "Premium / high-efficiency", "Not sure"],
    jobSubType:     ["Annual service", "Breakdown / repair"],
    heatingIssue:   ["Cold radiators", "Power flush / system clean", "Add a new radiator", "Something else"],
    plumbingIssue:  ["Leaking tap or pipe", "Blocked drain or toilet", "Toilet fault", "Something else"],
    certScope:      ["Single appliance (standard home)", "Multiple appliances or HMO"],
    bathroomScope:  ["Fit supplied fixtures", "Partial refit (fixtures + tiling)", "Full bathroom renovation"],
    timeline:       ["As soon as possible", "Within 2 weeks", "Within a month", "Just planning ahead"],
};

const CHOICE_VALUES = {
    projectType:    { "boiler service": "boilerService", "boiler repair": "boilerService", "bathroom fitting": "bathroomFitting", "gas safety certificate (cp12)": "gasSafeCert", "new boiler (install / replace)": "boilerInstall", "boiler service or repair": "boilerService", "heating issue (radiators, pipes)": "heating", "plumbing problem (leak, drain, tap)": "plumbing" },
    property:       { "domestic (home)": "domestic", "commercial (business)": "commercial", "not sure": "not_sure" },
    tier:           { "budget-friendly": "budget", "mid-range": "mid", "premium / high-efficiency": "premium", "not sure": "not_sure" },
    jobSubType:     { "annual service": "service", "breakdown / repair": "repair", "boiler repair": "repair", "boiler service": "service" },
    heatingIssue:   { "cold radiators": "cold_rads", "power flush / system clean": "power_flush", "add a new radiator": "new_rads", "something else": "other" },
    plumbingIssue:  { "leaking tap or pipe": "leaking", "blocked drain or toilet": "blocked", "toilet fault": "toilet", "something else": "other" },
    certScope:      { "single appliance (standard home)": "single", "multiple appliances or hmo": "multiple" },
    bathroomScope:  { "fit supplied fixtures": "fixtures", "partial refit (fixtures + tiling)": "partial", "full bathroom renovation": "full" },
    timeline:       { "as soon as possible": "t_asap", "within 2 weeks": "t_2weeks", "within a month": "t_month", "just planning ahead": "t_planning" },
};

function chipsFor(field) { return CHIP_LABELS[field] || []; }

function pendingField(sel) {
    const filled = (k) => sel && sel[k] != null && String(sel[k]).trim() !== "";
    for (const f of fieldOrder(sel)) if (!filled(f)) return f;
    return null;
}

// ---------------------------------------------------------------------------
//  Contact validation
// ---------------------------------------------------------------------------
const GMAIL_TYPOS = new Set([
    "gmial.com", "gmai.com", "gmal.com", "gmil.com", "gmali.com", "gamil.com",
    "gmaill.com", "gmaul.com", "gmsil.com", "gmaik.com", "gmqil.com", "gnail.com",
    "gmile.com", "gmaol.com", "gmail.con", "gmail.co", "gmail.cm",
    "gmail.om", "gmail.comm", "gmail.cpm", "gmail.vom", "gmail.xom", "gmail.ocm",
    "gmail.cim", "gmail.coom",
]);
function emailIssue(email) {
    const e = String(email || "").trim().toLowerCase();
    const m = e.match(/^[^\s@]+@([^\s@]+\.[^\s@]+)$/);
    if (!m) return "format";
    const domain = m[1];
    if (domain === "gmail.com") return null;
    if (domain.startsWith("gmail.")) return "gmail";
    if (GMAIL_TYPOS.has(domain)) return "gmail";
    return null;
}

function phoneIssue(phone) {
    const d = String(phone || "").replace(/[^\d]/g, "").replace(/^44/, "0");
    return d.length >= 10 && d.length <= 12 ? null : "format";
}

function postcodeIssue(pc) {
    const s = String(pc || "").trim().toUpperCase().replace(/\s+/g, "");
    return /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(s) ? null : "format";
}

function mapAnswer(field, answer) {
    if (typeof answer !== "string" || !answer.trim()) return null;
    const a = answer.trim();
    if (CHOICE_VALUES[field]) return CHOICE_VALUES[field][a.toLowerCase()] || null;
    if (CONTACT_FIELDS.includes(field)) return a;
    return null;
}

function extractData(text) {
    if (typeof text !== "string") return null;
    const m = text.match(/<!--DATA:(.*?)-->/s);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch (e) { return null; }
}

function mergeState(...states) {
    const out = {};
    for (const s of states) {
        if (!s || typeof s !== "object") continue;
        for (const k of Object.keys(s)) {
            const v = s[k];
            if (v != null && String(v).trim() !== "") out[k] = v;
        }
    }
    return out;
}

function nextChips(sel) {
    const f = pendingField(sel);
    return f ? chipsFor(f) : [];
}

// ---------------------------------------------------------------------------
//  Labels and recap
// ---------------------------------------------------------------------------
const LABELS = {
    projectType:    { boilerInstall: "Boiler installation", boilerService: "Boiler service / repair", heating: "Heating issue", plumbing: "Plumbing problem", gasSafeCert: "Gas safety certificate (CP12)", bathroomFitting: "Bathroom fitting" },
    property:       { domestic: "Domestic (home)", commercial: "Commercial (business)", not_sure: "Not sure" },
    tier:           { budget: "Budget-friendly", mid: "Mid-range", premium: "Premium / high-efficiency", not_sure: "Not sure (default: mid-range)" },
    jobSubType:     { service: "Annual service", repair: "Breakdown / repair" },
    heatingIssue:   { cold_rads: "Cold radiators", power_flush: "Power flush / system clean", new_rads: "Add a new radiator", other: "Something else" },
    plumbingIssue:  { leaking: "Leaking tap or pipe", blocked: "Blocked drain or toilet", toilet: "Toilet fault", other: "Something else" },
    certScope:      { single: "Single appliance (standard home)", multiple: "Multiple appliances or HMO" },
    bathroomScope:  { fixtures: "Fit supplied fixtures", partial: "Partial refit (fixtures + tiling)", full: "Full bathroom renovation" },
    timeline:       { t_asap: "As soon as possible", t_2weeks: "Within 2 weeks", t_month: "Within a month", t_planning: "Just planning ahead" },
};

function lbl(group, key) {
    return (LABELS[group] && LABELS[group][key]) || key || "-";
}

const CHOICE_FIELDS = ["projectType", "property", "tier", "jobSubType", "heatingIssue", "plumbingIssue", "certScope", "bathroomScope", "timeline"];

function sanitizeChoices(s) {
    if (!s || typeof s !== "object") return s;
    for (const field of CHOICE_FIELDS) {
        const v = s[field];
        if (v != null && String(v).trim() !== "" && !(String(v) in (LABELS[field] || {}))) delete s[field];
    }
    return s;
}

function summaryPairs(sel) {
    const pt = sel.projectType || "plumbing";
    const p  = [["Service", lbl("projectType", pt)], ["Property", lbl("property", sel.property)]];
    const has = (k) => sel[k] != null && String(sel[k]).trim() !== "";
    if (pt === "boilerInstall" && has("tier")) p.push(["Boiler grade", lbl("tier", sel.tier)]);
    if (pt === "boilerService" && has("jobSubType")) p.push(["Job type", lbl("jobSubType", sel.jobSubType)]);
    if (pt === "heating" && has("heatingIssue")) p.push(["Issue", lbl("heatingIssue", sel.heatingIssue)]);
    if (pt === "plumbing" && has("plumbingIssue")) p.push(["Issue", lbl("plumbingIssue", sel.plumbingIssue)]);
    if (pt === "gasSafeCert" && has("certScope")) p.push(["Certificate type", lbl("certScope", sel.certScope)]);
    if (pt === "bathroomFitting" && has("bathroomScope")) p.push(["Scope", lbl("bathroomScope", sel.bathroomScope)]);
    if (has("timeline")) p.push(["Timing", lbl("timeline", sel.timeline)]);
    return p;
}

// ---------------------------------------------------------------------------
//  Running estimate (shows in the live banner while questions are open)
// ---------------------------------------------------------------------------
function runningEstimate(sel) {
    const pt = sel && sel.projectType;
    if (!pt) return null;
    const filled = (k) => sel[k] != null && String(sel[k]).trim() !== "";
    if (!projectFields(pt).every(filled)) return null;
    const q = buildQuote(sel);
    return { low: q.low, high: q.high, partial: false };
}

// ---------------------------------------------------------------------------
//  Customer-facing estimate (multi-bubble, split by [[SPLIT]])
// ---------------------------------------------------------------------------
function renderCustomerQuote(quote, sel) {
    const pt   = sel.projectType || "plumbing";
    const what = (FLOW_LABEL[pt] || "job").toLowerCase();
    const items = quote.items
        .map(i => `• ${i.label} - **approx. ${formatGbp(i.low)} - ${formatGbp(i.high)}**`)
        .join("\n");

    const priceBubble = [
        `Thank you, ${sel.name || "there"}! Here is your **preliminary estimate** for your **${what}**.`,
        ``, `**Breakdown (indicative, with an approx. range):**`, items, ``,
        `**Estimated total: approx. ${formatGbp(quote.low)} - ${formatGbp(quote.high)}**`,
        validProp(sel.property) === "commercial" ? "(commercial work is quoted plus VAT)" : "(domestic prices, incl. VAT)",
    ].join("\n");

    let includes;
    if (pt === "boilerInstall") includes = "boiler supply and installation, flue, controls and commissioning";
    else if (pt === "boilerService" && sel.jobSubType === "service") includes = "a full Gas Safe inspection, clean and service certificate";
    else if (pt === "boilerService") includes = "a diagnostic callout plus the likely parts and labour to fix the fault";
    else if (pt === "heating") includes = "investigation and the likely parts and labour for the heating issue described";
    else if (pt === "gasSafeCert") includes = "a Gas Safe inspection of all relevant appliances and issue of the CP12 landlord / safety certificate";
    else if (pt === "bathroomFitting") includes = "all labour as described; materials and fixtures are included only where noted above";
    else includes = "a callout plus the likely parts and labour to fix the plumbing problem";

    const nextBubble = [
        `This is an **indicative estimate** - the **exact price is confirmed before any work begins**, once our engineer has visited and assessed the job.`,
        ``, `**What's included?** ${includes}.`, ``, `**What happens next?**`,
        `• Our engineer will **call you shortly** on the number you gave.`,
        `• Book your **free site visit** here: [${CALENDLY}](${CALENDLY})`,
        `• You'll then get a **fixed, written quote**.`,
        `• All gas and heating work is carried out by our **Gas Safe registered** engineers.`,
    ].join("\n");

    const recap = ["**Your enquiry in brief:**"];
    for (const [k, v] of summaryPairs(sel)) recap.push(`• ${k}: **${v}**`);

    return [priceBubble, nextBubble, recap.join("\n")].join("\n[[SPLIT]]\n");
}

// ---------------------------------------------------------------------------
//  System prompt
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `PERSONA
You are the digital quoting assistant for "Grants Plumbing and Heating", a Gas Safe registered plumbing and heating company serving the Furness and South Lakes area (Barrow-in-Furness, Ulverston, Kendal and surrounding villages). You cover all aspects of domestic and commercial plumbing, heating and gas work. Reply ONLY in English (UK).

TONE
- Polite, direct, expert and concise. Aim for under 40 words per reply.
- Ask ONE question at a time. Never ask several things at once.
- NEVER guess a price and NEVER do arithmetic - the system calculates the price at the end, as a range. Estimates are indicative and confirmed before work begins.

HANDLING QUESTIONS
- The customer may ask anything at any time (e.g. "are you Gas Safe?", "how long does a boiler install take?", "do you cover Barrow?"). Encourage this.
- If the customer ASKS something instead of answering, answer THEIR question briefly and clearly FIRST, then re-ask the current question.

FORMATTING
Write scannably, with Markdown (the system renders **bold** and "•" bullets):
- Always put the MAIN QUESTION on its own line, in **bold**.
- If options need explaining, list them with "• " prefix - option name in **bold**, dash, brief explanation.
- Keep it short. The system shows clickable buttons - you do NOT need to print them.
- Emphasise KEY WORDS in **bold**. Never bold whole sentences.
- When confirming an answer, quote it back in **bold** (e.g. "Got it, a **mid-range** boiler.").
- NEVER use emojis or icon characters - plain text only.
- NEVER use a long dash (em dash). Use a plain hyphen "-".

GOAL
Find out what they need, ask the relevant questions in order, then collect timing and contact details.
IMPORTANT: the system has already greeted the customer - do NOT greet again, start straight with question 0.

=== QUESTION 0 - ALWAYS FIRST ===
projectType - **bold** question: "What can we help you with today?", with bullets:
• **Boiler service** - annual Gas Safe inspection and certificate
• **Boiler repair** - breakdown or fault code showing
• **Bathroom fitting** - full fit-out or renovation
• **Gas safety certificate (CP12)** - for landlords and HMOs
• **New boiler** - supply and install a replacement boiler
• **Heating issue** - radiators, pipes or system problems
• **Plumbing problem** - leaks, blocked drains, taps or toilets
Values: boilerService | bathroomFitting | gasSafeCert | boilerInstall | heating | plumbing.
IMPORTANT: "Boiler service" sets projectType=boilerService AND jobSubType=service. "Boiler repair" sets projectType=boilerService AND jobSubType=repair. Both skip the jobSubType question.

=== BOILER INSTALLATION (boilerInstall) ===
1. property - "Is this for a home or a business?": • **Domestic (home)** • **Commercial (business)** -> domestic|commercial|not_sure
2. tier - "Which grade of boiler are you looking for?":
   • **Budget-friendly** - reliable and cost-effective (e.g. Baxi, Ideal)
   • **Mid-range** - popular makes with good warranties (e.g. Worcester, Vaillant)
   • **Premium / high-efficiency** - top-efficiency or system boiler (e.g. Viessmann)
   -> budget|mid|premium|not_sure

=== BOILER SERVICE OR REPAIR (boilerService) ===
1. property -> domestic|commercial|not_sure
2. jobSubType - "Is this a routine service or a breakdown?":
   • **Annual service** - Gas Safe inspection and certificate
   • **Breakdown / repair** - boiler not working or fault code showing
   -> service|repair

=== HEATING ISSUE (heating) ===
1. property -> domestic|commercial|not_sure
2. heatingIssue - "What's the heating problem?":
   • **Cold radiators** - one or more radiators not heating up properly
   • **Power flush / system clean** - noisy system, sludge or poor circulation
   • **Add a new radiator** - extend the system to another room
   • **Something else** - describe it and we'll advise
   -> cold_rads|power_flush|new_rads|other

=== PLUMBING PROBLEM (plumbing) ===
1. property -> domestic|commercial|not_sure
2. plumbingIssue - "What's the problem?":
   • **Leaking tap or pipe** - drip, wet patch or water damage
   • **Blocked drain or toilet** - slow drain or fully blocked
   • **Toilet fault** - won't flush, runs constantly, or leaking
   • **Something else** - describe it briefly
   -> leaking|blocked|toilet|other

=== GAS SAFETY CERTIFICATE / CP12 (gasSafeCert) ===
1. property -> domestic|commercial|not_sure
2. certScope - "How many gas appliances need certifying?":
   • **Single appliance** - standard home with one boiler
   • **Multiple appliances or HMO** - more than one appliance or a rental property with several gas points
   -> single|multiple

=== BATHROOM FITTING (bathroomFitting) ===
1. property -> domestic|commercial|not_sure
2. bathroomScope - "What level of work do you need?":
   • **Fit supplied fixtures** - you supply the suite, we fit it (labour only)
   • **Partial refit** - new fixtures plus tiling and plumbing alterations
   • **Full renovation** - full strip-out, replumb, tiling and all fixtures supplied and fitted
   -> fixtures|partial|full

=== ALL TYPES - AFTER THE ESSENTIALS ===
timeline - "When would you like the work done?" -> t_asap|t_2weeks|t_month|t_planning

CONTACT DETAILS - after timeline. Lead in briefly (e.g. "Perfect - to send your estimate, I just need a few details."). Then one at a time:
name - "What's your name?"
email - "What's your email address? We'll send the estimate there."
phone - "And your phone number? Our engineer will call you to confirm."
postcode - "Finally, your postcode? (e.g. LA14 1AA) We use it to plan the visit."

RULES
- Map free-text answers to the correct value where possible.
- If an answer is unclear, ask once more, then move on.
- Never promise a fixed price during the chat - the system shows the range.
- Only ask questions for the chosen job type.
- All boiler and gas work is Gas Safe registered - you can state this if asked.

HIDDEN STATE (REQUIRED IN EVERY REPLY)
At the very end of EVERY reply, output the running state in this hidden block:
<!--DATA:{"projectType":"","property":"","tier":"","jobSubType":"","heatingIssue":"","plumbingIssue":"","certScope":"","bathroomScope":"","timeline":"","name":"","email":"","phone":"","postcode":""}-->
Fill in only what the customer has actually answered. NEVER guess.
Allowed values: projectType: boilerInstall|boilerService|heating|plumbing|gasSafeCert|bathroomFitting; property: domestic|commercial|not_sure; tier: budget|mid|premium|not_sure; jobSubType: service|repair; heatingIssue: cold_rads|power_flush|new_rads|other; plumbingIssue: leaking|blocked|toilet|other; certScope: single|multiple; bathroomScope: fixtures|partial|full; timeline: t_asap|t_2weeks|t_month|t_planning. The rest (name, email, phone, postcode) are free text.
SPECIAL CASE: if customer chose "Boiler service" as their answer to question 0, set projectType=boilerService AND jobSubType=service in the DATA block immediately. If they chose "Boiler repair", set projectType=boilerService AND jobSubType=repair. Do NOT ask jobSubType again in these cases.
When every required field is filled, write a SHORT closing line (e.g. "Great, I'll put your estimate together now!") and still output the full DATA block.`;

function systemPromptFor() { return SYSTEM_PROMPT; }

const MSG = {
    reaskEmailTypo: "Oops, looks like a **typo** - the correct Gmail ending is **gmail.com**. Could you type your full email address again?",
    reaskEmail:     "I couldn't read that **email address**. Please type the full address (e.g. **name@gmail.com**).",
    reaskPhone:     "I couldn't read that **phone number**. Please give the full number (e.g. **07700 900123** or **01229 123456**).",
    reaskPostcode:  "That doesn't look like a full **UK postcode** (e.g. **LA14 1AA**). Please enter it that way.",
    rateChat:       "Too many messages in a short time. Please wait a moment and try again.",
    aiDown:         "Sorry, I can't reach the assistant right now. Please try again.",
    noParse:        "I understand, but I couldn't process that. Could you rephrase it?",
    serverErr:      "Sorry, the server is having a hiccup. Please try again a little later.",
};

// ---------------------------------------------------------------------------
//  AI providers
// ---------------------------------------------------------------------------
async function callOpenAI(messages) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return { ok: false, error: "Missing OPENAI_API_KEY" };
    try {
        const res = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
            body: JSON.stringify({
                model: process.env.OPENAI_MODEL || "gpt-4o-mini",
                messages,
                temperature: 0.4,
                max_tokens: 500,
            }),
        });
        const data = await res.json();
        const text = data.choices?.[0]?.message?.content;
        if (text) return { ok: true, text };
        return { ok: false, error: data.error?.message || JSON.stringify(data) };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

async function callGemini(messages) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return { ok: false, error: "Missing GEMINI_API_KEY" };
    const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
    const systemMsg = messages.find(m => m.role === "system");
    const contents = messages
        .filter(m => m.role !== "system")
        .map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
    try {
        const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    system_instruction: systemMsg ? { parts: [{ text: systemMsg.content }] } : undefined,
                    contents,
                    generationConfig: { temperature: 0.4, maxOutputTokens: 1000, thinkingConfig: { thinkingBudget: 0 } },
                }),
            }
        );
        const data = await res.json();
        const cand = data.candidates?.[0];
        const text = (cand?.content?.parts || []).map(p => p?.text || "").join("");
        if (cand?.finishReason === "MAX_TOKENS") console.warn("Gemini hit MAX_TOKENS - answer may be truncated.");
        if (text) return { ok: true, text };
        return { ok: false, error: data.error?.message || JSON.stringify(data) };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

// ---------------------------------------------------------------------------
//  Handler
// ---------------------------------------------------------------------------
export default async function handler(request, response) {
    applyCors(request, response);

    if (request.method === "OPTIONS") return response.status(204).end();
    if (request.method !== "POST") return response.status(405).json({ answer: "Method Not Allowed" });

    const ip = clientIp(request);

    try {
        const { question, history } = request.body || {};

        const rlChat = rateLimit(`chat:${ip}`, RL_CHAT.limit, RL_CHAT.windowMs);
        if (!rlChat.ok) {
            response.setHeader("Retry-After", String(rlChat.retryAfter));
            return response.status(429).json({ answer: MSG.rateChat });
        }
        const badInput = validateChatInput(question, history);
        if (badInput) return response.status(400).json({ answer: badInput });

        const { state } = request.body || {};

        // --- EARLY CONTACT VALIDATION ---
        {
            const priorSel = Array.isArray(history)
                ? history.filter(m => m && (m.role === "assistant" || m.role === "model")).map(m => extractData(m.content))
                : [];
            const baseSel = mergeState(state, ...priorSel);
            const pend = pendingField(baseSel);
            let reask = null;
            if (typeof question === "string" && question.trim()) {
                if (pend === "email") {
                    const i = emailIssue(question);
                    if (i === "gmail") reask = MSG.reaskEmailTypo;
                    else if (i) reask = MSG.reaskEmail;
                } else if (pend === "phone") {
                    if (phoneIssue(question)) reask = MSG.reaskPhone;
                } else if (pend === "postcode") {
                    if (postcodeIssue(question)) reask = MSG.reaskPostcode;
                }
            }
            if (reask) {
                return response.status(200).json({
                    answer: reask,
                    chips: [],
                    state: baseSel,
                    estimate: runningEstimate(baseSel),
                    progress: progressFields(baseSel).filter(f => baseSel[f] != null && String(baseSel[f]).trim() !== "").length,
                    progressTotal: progressFields(baseSel).length,
                });
            }
        }

        const messages = [{ role: "system", content: systemPromptFor() }];
        if (Array.isArray(history) && history.length > 0) {
            for (const m of history) {
                if (m && m.role && typeof m.content === "string") {
                    messages.push({ role: m.role === "model" ? "assistant" : m.role, content: m.content });
                }
            }
        } else if (question) {
            messages.push({ role: "user", content: question });
        }

        const provider = (process.env.AI_PROVIDER || "openai").toLowerCase();
        const result = provider === "gemini" ? await callGemini(messages) : await callOpenAI(messages);

        if (!result.ok) {
            console.error(`[${provider}] API Error:`, result.error);
            return response.status(200).json({ answer: MSG.aiDown });
        }

        let aiAnswer = result.text;
        if (!aiAnswer) return response.status(200).json({ answer: MSG.noParse });

        let currentSel = null;
        const dataMatch = aiAnswer.match(/<!--DATA:(.*?)-->/s);
        if (dataMatch) {
            try { currentSel = sanitizeChoices(JSON.parse(dataMatch[1])); }
            catch (e) { console.error("DATA parse fail:", e.message); }
            aiAnswer = aiAnswer.replace(/<!--DATA:.*?-->/s, "").trim();
        }

        const priorSel = Array.isArray(history)
            ? history.filter(m => m && (m.role === "assistant" || m.role === "model")).map(m => extractData(m.content))
            : [];
        const baseSel = mergeState(state, ...priorSel);

        const determined = {};
        const pending = pendingField(baseSel);
        if (pending) {
            const v = mapAnswer(pending, question);
            if (v) determined[pending] = v;
            // "Boiler repair" / "Boiler service" chips auto-fill jobSubType
            if (pending === "projectType") {
                const q = (question || "").trim().toLowerCase();
                if (q === "boiler repair") determined["jobSubType"] = "repair";
                else if (q === "boiler service") determined["jobSubType"] = "service";
            }
        }

        const sel = mergeState(currentSel, baseSel, determined);

        const progFields  = progressFields(sel);
        const progressTotal = progFields.length;
        const progress = progFields.filter(f => sel[f] != null && String(sel[f]).trim() !== "").length;

        if (isQuoteReady(sel)) {
            const quote = buildQuote(sel);

            console.log("\n========================================");
            console.log(`NEW ENQUIRY - ${FLOW_LABEL[sel.projectType] || "Plumbing/Heating"}`);
            console.log(`Customer: ${sel.name} | ${sel.phone} | ${sel.email}`);
            console.log(`Postcode: ${sel.postcode} | Property: ${sel.property}`);
            console.log(`Estimate: ${formatGbp(quote.low)} - ${formatGbp(quote.high)}`);
            console.log("========================================\n");

            return response.status(200).json({
                answer: renderCustomerQuote(quote, sel),
                chips: [],
                lead: { sel, quote },
                state: sel,
                estimate: { low: quote.low, high: quote.high, partial: false },
                progress: progressTotal,
                progressTotal,
            });
        }

        aiAnswer = aiAnswer.replace(/<!--CHIPS:.*?-->/s, "").trim();
        const chips = nextChips(sel);
        return response.status(200).json({ answer: aiAnswer, chips, state: sel, estimate: runningEstimate(sel), progress, progressTotal });

    } catch (error) {
        console.error("Function Crash:", error.message);
        return response.status(500).json({ answer: MSG.serverErr });
    }
}

export { buildQuote, runningEstimate };
