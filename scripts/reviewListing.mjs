/*
|--------------------------------------------------------------------------
| Try the automatic listing review by hand
|--------------------------------------------------------------------------
|
| Writes nothing. It calls the same reviewListing() the upload server uses,
| prints the verdict, and leaves Firestore alone — so it is safe to run
| against live data, and it is the way to tune the policy wording in
| src/config/policy.js without uploading test products.
|
|   # the built-in sample listings, which exercise each kind of decision
|   GEMINI_API_KEY=... node scripts/reviewListing.mjs
|
|   # one real listing, with its real Cloudinary photos
|   GEMINI_API_KEY=... node scripts/reviewListing.mjs <productId>
|
| Each run costs one request per listing, plus a retry per overloaded
| attempt. Mind the allowance: the free tier is 20 requests a DAY, so the
| six samples below are nearly a third of it.
|
|--------------------------------------------------------------------------
*/

import "dotenv/config";

import { reviewListing } from "../src/services/policyReviewService.js";

/*
 * Stand-in photos, so the samples have something to look at. Override them
 * with real listing photos to judge the photo rules:
 *
 *   SAMPLE_IMAGES=https://res.cloudinary.com/...jpg node scripts/reviewListing.mjs
 *
 * Be aware that a stock photo has nothing to do with the sample it is
 * attached to, so "photos unrelated to the item" is a CORRECT finding
 * against these samples. Read the text findings, not that one.
 */
const SAMPLE_IMAGES = (process.env.SAMPLE_IMAGES || "https://picsum.photos/id/0/900/900")
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean)
  .map((url) => ({ full: url }));

const SAMPLES = [
  {
    label: "ordinary used phone",
    expect: "approve",
    listing: {
      title: "Samsung Galaxy A20 64GB",
      category: "phones",
      condition: "used",
      location: "Nairobi",
      price: 12000,
      stock: 1,
      description:
        "Samsung Galaxy A20, 64GB storage, 3GB RAM, black. Screen is clean, small scratch on the back cover. Battery holds a full day. Comes with charger.",
    },
  },
  {
    label: "a service, which the app sells and the written policy forbids",
    expect: "approve",
    listing: {
      title: "Sofa set deep cleaning",
      category: "services",
      condition: "new",
      location: "Nairobi",
      price: 3500,
      stock: 1,
      description:
        "Professional deep cleaning for a 5-seater sofa set. We use a wet vacuum and fabric-safe shampoo. Takes about two hours and the sofa is dry by evening.",
    },
  },
  {
    label: "contact details in the description",
    expect: "flag",
    listing: {
      title: "Office desk, solid wood",
      category: "furniture",
      condition: "used",
      location: "Nakuru",
      price: 8000,
      stock: 1,
      description: "Strong wooden desk, two drawers. Call or WhatsApp me on 0712 345 678 to arrange.",
    },
  },
  {
    label: "counterfeit goods",
    expect: "flag",
    listing: {
      title: "Nike Air Force 1 - first copy, same as original",
      category: "shoes",
      condition: "new",
      location: "Nairobi",
      price: 2500,
      stock: 10,
      description: "Grade A first copy Nike Air Force. Cannot tell apart from the original. Sizes 39-45.",
    },
  },
  {
    label: "prohibited item",
    expect: "flag",
    listing: {
      title: "Amoxicillin 500mg capsules",
      category: "health",
      condition: "new",
      location: "Mombasa",
      price: 450,
      stock: 30,
      description: "Antibiotic capsules, full course. Sealed packet.",
    },
  },
  {
    label: "bait price",
    expect: "flag",
    listing: {
      title: "iPhone 15 Pro Max 256GB sealed",
      category: "phones",
      condition: "new",
      location: "Nairobi",
      price: 150,
      markedPrice: 180000,
      stock: 5,
      description: "Brand new sealed iPhone 15 Pro Max. Limited offer today only.",
    },
  },
];

function printVerdict(label, expected, verdict) {
  const agreed = !expected || verdict.decision === expected;
  const mark = expected ? (agreed ? "as expected" : "NOT as expected") : "";

  console.log(`\n${"=".repeat(70)}`);
  console.log(`${label}`);
  console.log(
    `  decision: ${verdict.decision}${expected ? `  (expected ${expected} — ${mark})` : ""}${verdict.failed ? "  [check did not run]" : ""}`
  );
  if (verdict.summary) console.log(`  summary:  ${verdict.summary}`);

  verdict.reasons.forEach((reason) => {
    console.log(`  - ${reason.rule}: ${reason.detail}`);
  });

  return agreed;
}

async function reviewOneProduct(productId) {
  // Imported lazily: the samples need no Firestore credentials.
  const { db } = await import("../src/config/firebase.js");

  const snapshot = await db.collection("products").doc(productId).get();

  if (!snapshot.exists) {
    console.error(`No product ${productId}.`);
    process.exit(1);
  }

  const listing = { id: snapshot.id, ...snapshot.data() };

  console.log(`Reviewing "${listing.title || listing.name}" with ${(listing.images || []).length} photo(s).`);
  console.log("Nothing is written back.");

  printVerdict(listing.title || listing.name || productId, null, await reviewListing(listing));

  process.exit(0);
}

const [productId] = process.argv.slice(2);

if (!process.env.GEMINI_API_KEY) {
  console.error("Set GEMINI_API_KEY first — without it every listing is flagged for a human by design.");
  process.exit(1);
}

if (productId) {
  await reviewOneProduct(productId);
} else {
  console.log(`Reviewing ${SAMPLES.length} sample listings with ${SAMPLES.length} API requests.`);
  console.log(`Photos: ${SAMPLE_IMAGES.map((image) => image.full).join(", ")}`);

  let agreedCount = 0;

  for (const sample of SAMPLES) {
    const verdict = await reviewListing({ ...sample.listing, images: SAMPLE_IMAGES });
    if (printVerdict(sample.label, sample.expect, verdict)) agreedCount += 1;
  }

  console.log(`\n${"=".repeat(70)}`);
  console.log(`${agreedCount}/${SAMPLES.length} verdicts matched what the policy should produce.`);

  process.exit(agreedCount === SAMPLES.length ? 0 : 1);
}
