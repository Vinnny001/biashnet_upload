/*
|--------------------------------------------------------------------------
| What the seller is told about the automatic check's verdict
|--------------------------------------------------------------------------
|
| Kept apart from sellerNotificationService.js, which reaches Firestore, so
| the wording can be tested without credentials. The wording is the part
| worth guarding: see the rule below.
|
| A FLAGGED LISTING IS NOT A REJECTION. Only an admin can reject one, and
| the check is explicitly a suggestion they may disagree with — so nothing
| here may tell a seller their listing was refused, or that they have done
| something wrong. It says the listing is with the team, and what the check
| noticed, because that is the part they can act on.
|
| The listing this was built from was flagged for a title of "Smart Phone"
| with no brand or model. That is a minute's work to fix — but only if
| someone tells the seller.
|
|--------------------------------------------------------------------------
*/

// Consistent with the main backend's productReviewNotificationService: the
// upload server falls back to the seller's email for sellerName, and an
// email address is not a name to greet someone by.
function sellerSalutation(sellerName) {
  const name = String(sellerName || "").trim();
  return name && !name.includes("@") ? `Dear Seller ${name},` : "Dear Seller,";
}

/*
 * At most two, and the rule rather than its full explanation: this is read
 * in a glance on a lock screen, and the findings in full are waiting on the
 * listing itself.
 */
export function summarizeReasons(reasons) {
  const rules = (Array.isArray(reasons) ? reasons : [])
    .map((reason) => String(reason?.rule || "").trim())
    .filter(Boolean);

  if (rules.length === 0) return "";

  const shown = rules.slice(0, 2).join("; ");

  return rules.length > 2 ? `${shown}; and ${rules.length - 2} more` : shown;
}

export function buildPolicyVerdictMessage({ listing, verdict }) {
  const name = String(listing?.title || listing?.name || "").trim() || "your product";
  const salutation = sellerSalutation(listing?.sellerName);

  if (verdict?.decision === "approve") {
    return {
      type: "PRODUCT_APPROVED",
      title: `Listing approved: ${name}`,
      message: `${salutation} your listing "${name}" passed our listing checks and is now live for buyers on Biashnet.`,
    };
  }

  /*
   * The check could not run at all — a spent request allowance, an outage.
   * As far as anyone knows there is nothing wrong with the listing, so
   * mentioning its content would be inventing a problem it does not have.
   */
  if (verdict?.failed) {
    return {
      type: "PRODUCT_PENDING_REVIEW",
      title: `Listing being reviewed: ${name}`,
      message:
        `${salutation} your listing "${name}" is being reviewed by our team. ` +
        "It stays hidden from buyers until it's approved. We'll let you know as soon as it's done.",
    };
  }

  const noticed = summarizeReasons(verdict?.reasons);

  return {
    type: "PRODUCT_PENDING_REVIEW",
    title: `Listing being reviewed: ${name}`,
    message:
      `${salutation} your listing "${name}" needs a closer look, so our team is reviewing it. ` +
      (noticed ? `Our checks noticed: ${noticed}. ` : "") +
      "It stays hidden from buyers until it's approved. You can edit the listing now if you'd like to fix anything.",
  };
}

export default buildPolicyVerdictMessage;
