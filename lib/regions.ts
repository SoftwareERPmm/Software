/**
 * Myanmar's subdivisions, as the partner form offers them and the
 * business_partner_region_check constraint enforces them.
 *
 * The country is seven states, seven regions and one union territory. They
 * are not interchangeable words: a state is named for the people whose home
 * it is, a region is not, and Nay Pyi Taw is neither. One column stores all
 * fifteen because the reporting question — where did the money come from —
 * does not care which kind a place is; the form keeps them in their three
 * groups so the distinction is visible to whoever is filling it in.
 */
export const MM_REGIONS = [
  "Ayeyarwady", "Bago", "Magway", "Mandalay", "Sagaing", "Tanintharyi", "Yangon",
] as const;

export const MM_STATES = [
  "Chin", "Kachin", "Kayah", "Kayin", "Mon", "Rakhine", "Shan",
] as const;

export const MM_UNION_TERRITORY = ["Nay Pyi Taw"] as const;

/** The three groups as the form draws them, in the order they are spoken. */
export const REGION_GROUPS = [
  { label: "Regions", options: MM_REGIONS },
  { label: "States", options: MM_STATES },
  { label: "Union territory", options: MM_UNION_TERRITORY },
] as const;

/** Flat, for validation — the same fifteen the CHECK constraint allows. */
export const REGIONS = [
  ...MM_REGIONS, ...MM_STATES, ...MM_UNION_TERRITORY,
] as const;

export type Region = (typeof REGIONS)[number];

/** Anything not on the list is stored as NULL — unknown, rather than guessed. */
export const asRegion = (v: string | null | undefined): Region | null =>
  v && (REGIONS as readonly string[]).includes(v) ? (v as Region) : null;
