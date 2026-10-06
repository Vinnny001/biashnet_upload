import axios from "axios";

import { LISTING_POLICY } from "../config/policy.js";

/*
|--------------------------------------------------------------------------
| AUTOMATIC LISTING REVIEW
|--------------------------------------------------------------------------
|
| Every listing used to wait for an admin before buyers could see it. This
| reads the listing first — its text and its photos — against the seller
| listing policy. A listing that meets the policy goes live immediately; a
| listing with anything wrong with it, or that could not be checked, goes to
| an admin with the reasons attached.
|
| It never rejects anything. "flag" means "a human decides", nothing more,
| so a mistake here costs a delay and never a wrongly removed listing.
|
| FAIL SAFE. Every failure path — no API key, a timeout, an overloaded
| model, a reply that will not parse — returns a flag, so the worst this can
| do is hand an admin the work they were doing before it existed. It must
| never approve something it did not actually read.
|
| Shapes below were verified against the live API, not inferred: the request
| rejects the older `parts`/`inline_data` form with "Unknown parameter
| 'parts'", and the REST reply carries no `output_text`, so the text has to
| be read out of `steps`.
|
|--------------------------------------------------------------------------
*/

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";

const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";

/*
 * The model is often briefly overloaded (HTTP 503, "service_unavailable"),
 * so retrying is the normal path rather than the exception. This runs in the
 * background, after the listing is already saved, so it can afford to wait
 * rather than give up and wake an admin.
 *
 * Kept short deliberately: a rejected attempt still counts against the
 * project's request quota, so a long retry chain on a busy model can spend
 * the day's allowance on a handful of listings. Raise it on a paid tier,
 * where overload is rarer and the allowance is not measured in tens.
 */
const RETRY_DELAYS_MS = [3000, 10000];

const REQUEST_TIMEOUT_MS = 60000;

/*
 * Photos are read at the 900px variant: enough to read a phone number or a
 * watermark, which the 300px thumbnail is not. Each image costs over a
 * thousand tokens regardless of size, so the count is capped — the cover
 * photo and the next few carry almost all the risk.
 */
const MAX_IMAGES = Number(process.env.AI_REVIEW_MAX_IMAGES) || 4;

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

const IMAGE_TIMEOUT_MS = 15000;

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    decision: {
      type: "string",
      enum: ["approve", "flag"],
    },
    reasons: {
      type: "array",
      items: {
        type: "object",
        properties: {
          rule: { type: "string" },
          detail: { type: "string" },
        },
        required: ["rule", "detail"],
      },
    },
    summary: { type: "string" },
  },
  required: ["decision", "reasons", "summary"],
};

export function isPolicyReviewEnabled() {
  return Boolean(process.env.GEMINI_API_KEY);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/*
 * Retry an overloaded or unreachable model, but not a rejected request: a
 * 400 means the body is wrong and will be wrong again.
 *
 * 429 is deliberately NOT retried. It is the daily or per-minute request
 * allowance, and the API answers it with how long to wait — hours, on the
 * free tier's 20-a-day. Waiting seconds cannot clear it, so the listing goes
 * straight to an admin instead of stalling first.
 */
function isRetryable(error) {
  const status = error?.response?.status;

  if (!status) return true;

  if (status === 429) return false;

  return status === 408 || status >= 500;
}

/*
 * Worth its own line in the log: every listing will be going to an admin
 * until the allowance resets, and nothing else explains why.
 */
function isQuotaExhausted(error) {
  return error?.response?.status === 429;
}

function errorDetail(error) {
  return (
    error?.response?.data?.error?.message ||
    error?.response?.data?.message ||
    error?.message ||
    "unknown error"
  );
}

/*
|--------------------------------------------------------------------------
| THE LISTING, AS THE MODEL READS IT
|--------------------------------------------------------------------------
*/

function describeListing(listing) {
  const lines = [
    ["Title", listing.title || listing.name],
    ["Category", listing.category],
    ["Subcategory", listing.subCategory],
    ["Condition", listing.condition],
    ["Location", listing.location],
    ["Price", listing.price ? `KES ${Number(listing.price).toLocaleString("en-KE")}` : ""],
    [
      'Was price ("old" price shown struck through)',
      Number(listing.markedPrice) > 0
        ? `KES ${Number(listing.markedPrice).toLocaleString("en-KE")}`
        : "",
    ],
    ["Stock", listing.stock === undefined ? "" : String(listing.stock)],
  ]
    .filter(([, value]) => String(value || "").trim())
    .map(([label, value]) => `${label}: ${value}`);

  const description = String(listing.description || "").trim();

  return [
    "Review this listing against the policy.",
    "",
    ...lines,
    "",
    "Description:",
    description || "(the seller left the description empty)",
  ].join("\n");
}

/*
 * Cloudinary gives several sizes per image; `full` is the 900px one. A
 * listing's images may also arrive as bare URL strings on older records.
 */
function imageUrl(image) {
  if (typeof image === "string") return image;
  if (!image || typeof image !== "object") return "";

  return image.full || image.original || image.thumb || image.small || "";
}

async function fetchImagePart(url) {
  const response = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: IMAGE_TIMEOUT_MS,
    maxContentLength: MAX_IMAGE_BYTES,
  });

  const mimeType = String(response.headers["content-type"] || "").split(";")[0].trim();

  if (!mimeType.startsWith("image/")) {
    throw new Error(`${url} is not an image (${mimeType || "no content type"})`);
  }

  return {
    type: "image",
    mime_type: mimeType,
    data: Buffer.from(response.data).toString("base64"),
  };
}

/*
 * A photo that cannot be downloaded is not the seller's fault and not a
 * policy breach, so it is skipped rather than failing the check. The model
 * is told how many it is actually looking at, so it never reasons about a
 * photo it was not shown.
 */
async function imageParts(images) {
  const urls = (Array.isArray(images) ? images : [])
    .map(imageUrl)
    .filter((url) => /^https?:\/\//i.test(url))
    .slice(0, MAX_IMAGES);

  const settled = await Promise.allSettled(urls.map(fetchImagePart));

  const parts = [];

  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      parts.push(result.value);
      return;
    }

    console.error(
      `Policy review: skipping photo ${index + 1} —`,
      result.reason?.message || result.reason
    );
  });

  return parts;
}

/*
|--------------------------------------------------------------------------
| READING THE REPLY
|--------------------------------------------------------------------------
*/

function textFromInteraction(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  /*
   * The reply is a list of steps — the model's own reasoning among them.
   * Only `model_output` is the answer.
   */
  return (Array.isArray(payload?.steps) ? payload.steps : [])
    .filter((step) => step?.type === "model_output")
    .flatMap((step) => (Array.isArray(step.content) ? step.content : []))
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
    .trim();
}

function parseVerdict(text) {
  if (!text) throw new Error("the model returned nothing");

  try {
    return JSON.parse(text);
  } catch {
    /*
     * Asked for JSON and given JSON in a code fence, or with a sentence in
     * front of it. Take the outermost object.
     */
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");

    if (start === -1 || end <= start) {
      throw new Error(`the model's reply was not JSON: ${text.slice(0, 200)}`);
    }

    return JSON.parse(text.slice(start, end + 1));
  }
}

function normalizeReasons(reasons) {
  return (Array.isArray(reasons) ? reasons : [])
    .map((reason) => {
      if (typeof reason === "string") {
        return { rule: "Policy", detail: reason.trim() };
      }

      return {
        rule: String(reason?.rule || "Policy").trim(),
        detail: String(reason?.detail || "").trim(),
      };
    })
    .filter((reason) => reason.detail)
    .slice(0, 10);
}

/*
 * Only the exact word "approve" approves. Anything else — a flag, an empty
 * answer, a word the model invented — goes to a human.
 */
function normalizeVerdict(parsed, meta) {
  const approved = String(parsed?.decision || "").trim().toLowerCase() === "approve";

  const reasons = normalizeReasons(parsed?.reasons);

  const summary = String(parsed?.summary || "").trim();

  /*
   * An approval that lists violations contradicts itself. Trust the
   * violations and let a human settle it.
   */
  if (approved && reasons.length > 0) {
    return {
      decision: "flag",
      reasons,
      summary: summary || "The automatic check approved this listing but also listed problems with it.",
      ...meta,
    };
  }

  return {
    decision: approved ? "approve" : "flag",
    reasons: approved ? [] : reasons,
    summary,
    ...meta,
  };
}

function couldNotCheck(detail) {
  return {
    decision: "flag",
    reasons: [
      {
        rule: "Not checked automatically",
        detail: `The automatic check could not complete, so this listing needs a human: ${detail}`,
      },
    ],
    summary: "The automatic check could not complete. Please review this listing.",
    model: MODEL,
    interactionId: null,
    failed: true,
  };
}

/*
|--------------------------------------------------------------------------
| THE CHECK
|--------------------------------------------------------------------------
|
| Always resolves. A caller in the background has nothing useful to do with
| a rejected promise, and a thrown error here must never be the reason a
| listing is left in limbo.
|
*/

export async function reviewListing(listing) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) return couldNotCheck("no GEMINI_API_KEY is configured");

  let content;

  try {
    const photos = await imageParts(listing?.images);

    content = [
      { type: "text", text: describeListing(listing || {}) },
      {
        type: "text",
        text: photos.length
          ? `The seller's ${photos.length === 1 ? "photo follows" : `${photos.length} photos follow`}, in the order buyers see them. The first is the cover image.`
          : "No photos could be read for this listing, so judge the text only and flag it as unverified photos.",
      },
      ...photos,
    ];
  } catch (error) {
    return couldNotCheck(`the listing's photos could not be prepared (${errorDetail(error)})`);
  }

  const body = {
    model: MODEL,
    system_instruction: LISTING_POLICY,
    input: [{ type: "user_input", content }],
    response_format: {
      type: "text",
      mime_type: "application/json",
      schema: VERDICT_SCHEMA,
    },
    /*
     * Nothing here is a conversation to resume, and a listing's text and
     * photos are the seller's, so they are not kept on Google's side.
     */
    store: false,
  };

  let lastError = "";

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) await wait(RETRY_DELAYS_MS[attempt - 1]);

    let data;

    try {
      ({ data } = await axios.post(ENDPOINT, body, {
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
      }));
    } catch (error) {
      lastError = errorDetail(error);

      if (isQuotaExhausted(error)) {
        console.error(
          "Policy review: request allowance used up — every listing goes to an admin until it resets.",
          lastError
        );
      }

      /*
       * A rejected request will be rejected again — only an overloaded or
       * unreachable model is worth asking twice.
       */
      if (!isRetryable(error)) return couldNotCheck(lastError);

      console.error(`Policy review attempt ${attempt + 1} failed:`, lastError);

      continue;
    }

    /*
     * The model answered. Whatever it said, asking again will not make it
     * parse, so a bad reply ends the check rather than restarting it.
     */
    try {
      return normalizeVerdict(parseVerdict(textFromInteraction(data)), {
        model: data?.model || MODEL,
        interactionId: data?.id || null,
      });
    } catch (error) {
      return couldNotCheck(`the model's answer could not be read (${errorDetail(error)})`);
    }
  }

  return couldNotCheck(lastError || "the model could not be reached");
}

/*
 * Exported for the tests. Reading the reply and normalizing it is where a
 * wrong answer would quietly become an approval, so those steps are checked
 * directly rather than only through a live call.
 */
export const internals = {
  describeListing,
  textFromInteraction,
  parseVerdict,
  normalizeVerdict,
  isRetryable,
};

export const policyReviewService = {
  reviewListing,
  isPolicyReviewEnabled,
};

export default policyReviewService;
