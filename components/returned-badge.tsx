import { qty } from "@/lib/format";

/**
 * How much of a receipt went back.
 *
 * Not a posting status: the receipt posted, and the goods did arrive. What
 * changed afterwards is that some or all of them left again, and that is
 * invisible in "POSTED" — a receipt for a hundred units that were all sent
 * back reads exactly like one whose goods are on the shelf.
 */
export function ReturnedBadge({
  received, returned, state,
}: { received: number; returned: number; state: "NONE" | "SOME" | "ALL" }) {
  if (state === "NONE") return <span className="pill returned-none">Not returned</span>;

  return (
    <span className={`pill ${state === "ALL" ? "returned-all" : "returned-some"}`}>
      {state === "ALL" ? "Fully returned" : "Partially returned"}
      {" · "}
      {qty(returned)} of {qty(received)}
    </span>
  );
}
