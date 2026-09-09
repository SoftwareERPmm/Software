-- Which half of an invoice a person is responsible for.
--
-- A purchase invoice has two things outstanding and they are owed by
-- different people: goods that have not arrived, which somebody chases the
-- supplier about, and money that has not been paid, which somebody in
-- accounts releases. One "responsible person" on the document cannot answer
-- both, and picking the task by reading its name — anything containing
-- "payment" is the money one — is the kind of rule that works until somebody
-- writes "Chase payment for the missing goods".
--
-- Null stays the ordinary case: a task about the document as a whole.

alter table document_task
  add column if not exists aspect text
  check (aspect is null or aspect in ('GOODS', 'PAYMENT'));

comment on column document_task.aspect is
    'Which side of the document this task is about, where a document has two '
    'that run independently: GOODS still expected, PAYMENT still owed.';
