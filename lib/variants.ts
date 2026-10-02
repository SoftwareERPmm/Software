/**
 * Which picture belongs to which variant.
 *
 * A shirt is photographed once per colour. Black in S, M and L is the same
 * garment and the same photograph, so the picture is held against the
 * colour rather than against each combination — upload it on any one size
 * and every size of that colour shows it.
 *
 * Pure, and imports nothing: a client component and a server page both need
 * the same answer, and two copies of this rule would eventually disagree
 * about which shirt is red.
 */

export type VariantPart = {
  attributeId: string; attribute: string;
  optionId: string; option: string;
  optionSort: number; attributeSort: number;
};

export type PhotoBearing = {
  id: string;
  photo_version: string | null;
  parts: VariantPart[] | null;
};

export type VariantPhotos = {
  /** The attribute the pictures belong to — colour, in a clothing
   *  catalogue. Null when nothing has a photo yet. */
  photoAttributeId: string | null;
  /** The variant whose photo stands for this one, or null. */
  pictureFor: (row: PhotoBearing) => PhotoBearing | null;
  /** A ready `/items/:id/photo` URL, or null. */
  srcFor: (row: PhotoBearing) => string | null;
};

/**
 * Works out which attribute carries the pictures, then indexes them by its
 * options.
 *
 * "Which attribute" is decided by counting: the one whose distinct values
 * have photographs against them. In a catalogue of shirts that is colour,
 * because somebody uploaded a red one and a black one and never a photo of
 * "size M". Deciding it from the data rather than looking for an attribute
 * literally called Colour means it also works for a catalogue that varies
 * by Finish, or Pattern, or a Burmese word for either.
 */
export function variantPhotos(rows: PhotoBearing[]): VariantPhotos {
  const scores = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.photo_version || !r.parts) continue;
    for (const p of r.parts) {
      const seen = scores.get(p.attributeId) ?? new Set<string>();
      seen.add(p.optionId);
      scores.set(p.attributeId, seen);
    }
  }

  let photoAttributeId: string | null = null;
  let best = 0;
  for (const [attributeId, seen] of scores) {
    if (seen.size > best) { best = seen.size; photoAttributeId = attributeId; }
  }

  // The first variant found carrying a photo for each value of that
  // attribute. First rather than newest because they are meant to be the
  // same picture; if they are not, the catalogue has a bigger problem than
  // which one this picks.
  const byOption = new Map<string, PhotoBearing>();
  if (photoAttributeId) {
    for (const r of rows) {
      if (!r.photo_version || !r.parts) continue;
      const p = r.parts.find((x) => x.attributeId === photoAttributeId);
      if (p && !byOption.has(p.optionId)) byOption.set(p.optionId, r);
    }
  }

  const pictureFor = (row: PhotoBearing): PhotoBearing | null => {
    // An ordinary item, or a variant of something that varies by no
    // attribute anybody has photographed: its own picture or none.
    if (!row.parts || row.parts.length === 0 || !photoAttributeId) {
      return row.photo_version ? row : null;
    }
    const p = row.parts.find((x) => x.attributeId === photoAttributeId);
    if (!p) return row.photo_version ? row : null;
    return byOption.get(p.optionId) ?? (row.photo_version ? row : null);
  };

  const srcFor = (row: PhotoBearing) => {
    const shot = pictureFor(row);
    return shot ? `/items/${shot.id}/photo?v=${shot.photo_version}` : null;
  };

  return { photoAttributeId, pictureFor, srcFor };
}
