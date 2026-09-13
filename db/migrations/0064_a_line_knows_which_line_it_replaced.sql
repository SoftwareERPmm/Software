-- Which line replaced which, said rather than guessed.
--
-- Correcting an order posts a new version with new lines, and three things
-- afterwards need to know which new line stands in for which old one: the
-- price a cascaded invoice should carry, how much of a line has already been
-- billed, and which line a receipt's goods answer.
--
-- All three were guessing. First by item, which broke the moment one item sat
-- on two lines of an order at two prices — twenty at a thousand and thirty at
-- twelve hundred, and a bill for the second refused for quoting the price its
-- own line agreed. Then by position, which is right until a line is inserted
-- or removed and silently wrong afterwards.
--
-- The correction form has known the answer all along: it edits the lines it
-- was given and sends each one's id back. It was thrown away on the way in.
-- Now it is kept, and the three readers follow it instead of inferring it.
--
-- Null on every line posted outside a correction, and on every line corrected
-- before this migration — those fall back to the old inference, which is no
-- worse than what they had.

alter table document_line
    add column supersedes_line_id uuid references document_line(id);

comment on column document_line.supersedes_line_id is
    'The line of the previous version of this document that this line '
    'replaces. Recorded by the correction that posted it; null on an '
    'ordinary posting.';

create index document_line_supersedes on document_line (supersedes_line_id)
    where supersedes_line_id is not null;

-- The line standing now for whatever line this id belongs to. A line never
-- corrected is its own answer; one that has been resolves forward through the
-- corrections that replaced it. The line-level twin of fn_current_document.
create or replace function fn_current_line(p_id uuid) returns uuid
language sql stable as $$
    with recursive chain as (
        select dl.id, 0 as depth
          from document_line dl where dl.id = p_id
        union all
        select dl.id, c.depth + 1
          from document_line dl
          join chain c on dl.supersedes_line_id = c.id
    )
    select id from chain order by depth desc limit 1;
$$;

comment on function fn_current_line(uuid) is
    'The line standing now for the line this id belongs to, followed forward '
    'through corrections. The line-level twin of fn_current_document.';
