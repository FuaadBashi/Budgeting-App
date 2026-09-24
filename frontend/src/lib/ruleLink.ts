/**
 * A link to the Rules tab with a new rule already filled in from a row.
 *
 * The pattern drops the long digit runs banks append (terminal ids, dates,
 * references) -- "TESCO STORES 3421" becomes "TESCO STORES" -- because a rule
 * on the raw text would only ever match that one store on that one terminal.
 * Mirrors the backend's `normalise_description` rule for digits, not the rest
 * of it: the person should still recognise their merchant in the box.
 */
export function ruleLink({
  description,
  merchant,
  categoryId,
}: {
  description: string;
  merchant?: string | null;
  categoryId?: string | null;
}): string {
  const source = (merchant || description || "").replace(/\b\d{4,}\b/g, " ");
  const pattern = source.replace(/\s+/g, " ").trim();
  const params = new URLSearchParams({ tab: "rules" });
  if (pattern) params.set("pattern", pattern);
  if (categoryId) params.set("category", categoryId);
  return `/accounts?${params.toString()}`;
}
