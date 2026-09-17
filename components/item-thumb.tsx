import { ImageOff } from "lucide-react";

/**
 * The item's picture at the size a list can afford.
 *
 * 25px square, always — a catalogue whose rows are 25px, 25px, 60px, 25px is
 * a catalogue that jitters as it loads, so the box exists whether there is a
 * photo in it or not. The picture is fitted to that box by covering it, never
 * by being squashed into it: a portrait shot of a phone loses a little top
 * and bottom rather than becoming a fat phone, which at this size is the
 * difference between recognising it and not.
 *
 * Most items have no photo and are not missing anything. The empty box is
 * quiet — a faint outline, a muted mark — rather than a broken-image icon
 * asking to be fixed.
 */
export function ItemThumb({ src, name }: { src: string | null; name: string }) {
  if (!src) {
    return (
      <span className="item-thumb item-thumb-empty" aria-hidden="true">
        <ImageOff size={12} />
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- served straight
    // from the database by a route of our own; next/image would proxy and
    // re-encode something already encoded to exactly this purpose.
    <img className="item-thumb" src={src} alt={`Photo of ${name}`} width={25} height={25} loading="lazy" />
  );
}
