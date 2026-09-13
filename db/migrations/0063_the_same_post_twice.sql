-- The same submission, posted once.
--
-- Every posting path in this app has been free to run twice. A double-click,
-- a browser retrying a request it thinks failed, a flaky connection resent by
-- the platform — each produces a second identical document, a second set of
-- stock movements and a second journal entry, all individually correct and
-- none of them wanted.
--
-- This is deliberately not the same question as over-receipt. Goods really
-- can arrive twice, and a second receipt for a second delivery is a fact
-- worth recording; the engine allows it and should. What must not happen is
-- one attempt becoming two documents because the wire hiccuped.
--
-- So an attempt carries a key. The first request to claim a key owns it and
-- posts; any other request carrying that key waits for the first to finish
-- and is handed the document it made, rather than making another. A new
-- attempt — the user deliberately recording a second delivery — carries a new
-- key and posts normally.
--
-- The claim is a row, not a lock held in memory: it survives a restart, and
-- two application instances see the same one.

create table posting_attempt (
    company_id   uuid        not null references company(id) on delete cascade,
    key          text        not null,
    -- Null while the posting is in flight. Filled when it commits, which is
    -- what a waiting duplicate is waiting for.
    document_id  uuid        references document(id) on delete cascade,
    doc_no       text,
    claimed_at   timestamptz not null default now(),
    settled_at   timestamptz,
    primary key (company_id, key)
);

comment on table posting_attempt is
    'One posting attempt, identified by a key the client generates per '
    'submission. A retry of the same attempt is handed the document the '
    'first one posted instead of posting again; a deliberate second '
    'transaction carries a new key and posts normally.';

comment on column posting_attempt.document_id is
    'What the attempt posted. Null while it is still in flight, and null for '
    'ever if it failed — a failed claim is not a posted document, and the '
    'next attempt with that key is allowed to take it over.';

-- Reading back what an attempt posted, and finding stale claims.
create index posting_attempt_document on posting_attempt (document_id);
create index posting_attempt_claimed on posting_attempt (claimed_at)
    where settled_at is null;
