import { getCompany, getNotes } from "@/lib/queries";
import { NotesList } from "@/components/notes-list";

export default async function DebitNotes() {
  const company = await getCompany();
  if (!company) return <div className="empty">No company found.</div>;

  const notes = (await getNotes(company.id, "DEBIT_NOTE")) as unknown as Parameters<typeof NotesList>[0]["notes"];
  return <NotesList kind="debit" notes={notes} />;
}
