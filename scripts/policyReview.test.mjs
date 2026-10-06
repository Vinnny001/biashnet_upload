/*
 * Logic tests for src/services/policyReviewService.js — no API calls.
 * The live end-to-end check is policyreview.live.mjs.
 */
delete process.env.GEMINI_API_KEY;

const { internals, reviewListing, isPolicyReviewEnabled } = await import(
  "../src/services/policyReviewService.js"
);

const { textFromInteraction, parseVerdict, normalizeVerdict, describeListing, isRetryable } = internals;

let failures = 0;
let total = 0;
function check(name, pass, extra = "") {
  total += 1;
  if (!pass) failures += 1;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
}

/* ---- reading the reply: the exact shape the live API returned ---- */

const REAL_REPLY = {
  id: "v1_Chd5eVhF",
  status: "completed",
  model: "gemini-3.8-flash",
  steps: [
    { signature: "EsAKCr0KAWkUfRPWrPElr", type: "thought" },
    {
      content: [
        {
          text: '{\n  "decision": "flag",\n  "reasons": [\n    {"rule":"Counterfeit goods","detail":"Described as a first copy"}\n  ],\n  "summary": "Counterfeit shoes."\n}',
          type: "text",
        },
      ],
      type: "model_output",
    },
  ],
  object: "interaction",
};

const text = textFromInteraction(REAL_REPLY);
check("reads the answer out of steps, ignoring the thought step", text.startsWith("{") && text.includes('"flag"'), text.slice(0, 30));
check("does not leak the thought signature into the answer", !text.includes("EsAKCr0KAWkUfRPWrPElr"));
check("prefers output_text when the API supplies it", textFromInteraction({ output_text: " hi ", steps: [] }) === "hi");
check("empty when there is no model_output", textFromInteraction({ steps: [{ type: "thought" }] }) === "");

/* ---- parsing ---- */

check("parses plain JSON", parseVerdict('{"decision":"approve"}').decision === "approve");
check(
  "parses JSON in a code fence",
  parseVerdict('```json\n{"decision":"approve","reasons":[]}\n```').decision === "approve"
);
check(
  "parses JSON with prose in front of it",
  parseVerdict('Here is my verdict:\n{"decision":"flag","reasons":[]}').decision === "flag"
);
check("throws on an empty answer", (() => { try { parseVerdict(""); return false; } catch { return true; } })());
check("throws on an answer with no JSON", (() => { try { parseVerdict("I cannot help"); return false; } catch { return true; } })());

/* ---- normalizing: the safety-critical part ---- */

const meta = { model: "m", interactionId: "i" };

check(
  "a clean approval approves",
  normalizeVerdict({ decision: "approve", reasons: [], summary: "A phone." }, meta).decision === "approve"
);

const contradiction = normalizeVerdict(
  { decision: "approve", reasons: [{ rule: "Counterfeit goods", detail: "first copy" }], summary: "" },
  meta
);
check(
  "an approval that also lists violations is sent to a human",
  contradiction.decision === "flag" && contradiction.reasons.length === 1,
  contradiction.decision
);

check("APPROVE in capitals still approves", normalizeVerdict({ decision: "  APPROVE ", reasons: [] }, meta).decision === "approve");
check("a flag flags", normalizeVerdict({ decision: "flag", reasons: [] }, meta).decision === "flag");
check("a missing decision flags", normalizeVerdict({ reasons: [] }, meta).decision === "flag");
check("an invented decision flags", normalizeVerdict({ decision: "maybe", reasons: [] }, meta).decision === "flag");
check("an empty object flags", normalizeVerdict({}, meta).decision === "flag");
check("null flags", normalizeVerdict(null, meta).decision === "flag");

const stringy = normalizeVerdict({ decision: "flag", reasons: ["Phone number in the description"] }, meta);
check(
  "reasons given as bare strings are still usable",
  stringy.reasons[0].rule === "Policy" && stringy.reasons[0].detail === "Phone number in the description",
  JSON.stringify(stringy.reasons)
);

check(
  "reasons with no detail are dropped",
  normalizeVerdict({ decision: "flag", reasons: [{ rule: "X", detail: "  " }] }, meta).reasons.length === 0
);

check(
  "a runaway list of reasons is capped",
  normalizeVerdict(
    { decision: "flag", reasons: Array.from({ length: 40 }, (_, i) => ({ rule: "R", detail: `d${i}` })) },
    meta
  ).reasons.length === 10
);

check(
  "an approval carries no reasons through",
  normalizeVerdict({ decision: "approve", reasons: [] }, meta).reasons.length === 0
);

check("metadata is kept", normalizeVerdict({ decision: "approve", reasons: [] }, meta).model === "m");

/* ---- retry policy ---- */

check("retries a 503 overload", isRetryable({ response: { status: 503 } }) === true);
check("retries a network failure", isRetryable({ message: "socket hang up" }) === true);
check("does NOT retry a spent request allowance (429)", isRetryable({ response: { status: 429 } }) === false);
check("does NOT retry a rejected request (400)", isRetryable({ response: { status: 400 } }) === false);

/* ---- the listing as the model sees it ---- */

const described = describeListing({
  title: "Samsung A20",
  category: "phones",
  condition: "used",
  price: 12000,
  markedPrice: 0,
  description: "Clean phone",
  stock: 2,
});
check("includes the fields that carry policy risk", described.includes("Title: Samsung A20") && described.includes("Condition: used") && described.includes("Clean phone"));
check("prices are written as money, not raw numbers", described.includes("KES 12,000"), described.match(/Price:.*/)?.[0]);
check("a zero was-price is left out rather than shown as KES 0", !described.includes("Was price"));
check(
  "an empty description is called out, not left blank",
  describeListing({ title: "x" }).includes("the seller left the description empty")
);

/* ---- fail-safe with no key ---- */

check("the check reports itself disabled without a key", isPolicyReviewEnabled() === false);

const noKey = await reviewListing({ title: "Anything", images: [] });
check("no key means a human looks at it", noKey.decision === "flag", noKey.decision);
check("no key is recorded as a failure, not a real verdict", noKey.failed === true);
check("no key still explains itself to the admin", /GEMINI_API_KEY/.test(noKey.reasons[0]?.detail || ""), noKey.reasons[0]?.detail);

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures === 0 ? 0 : 1);
