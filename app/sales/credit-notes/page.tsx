import { getCompany, getNotes } from "@/lib/queries";
import { NotesList } from "@/components/notes-list";

export default async function CreditNotes() {
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const notes = (await getNotes(company.id, "CREDIT_NOTE")) as unknown as Parameters<typeof NotesList>[0]["notes"];
  return <NotesList kind="credit" notes={notes} />;
}
