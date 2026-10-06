-- TD-204 - a document's own "uploaded" and "reviewed" dates.
--
-- ================================================================================================
-- WHY. The document reports showed `created_at` as "Uploaded" and `updated_at` as "Reviewed".
-- created_at is when the checklist row was made, usually weeks before any file arrived; updated_at
-- moves on ANY change to the row, a rename included. Measured on the live system on 2026-10-06:
-- of the 22 documents whose upload is in the history, 11 showed the wrong upload date.
--
-- NULL MEANS "NOT KNOWN", AND THAT IS DELIBERATE. Where the history does not say when a file
-- arrived or when it was reviewed (imported deals carry no history), the column stays NULL and the
-- report shows a dash. A blank is honest; borrowing another date is what this migration undoes.
-- ================================================================================================

ALTER TABLE "documents" ADD COLUMN "uploaded_at" TIMESTAMP(0);
ALTER TABLE "documents" ADD COLUMN "reviewed_at" TIMESTAMP(0);

-- ---- Backfill from the Audit Trail, only where it actually records the event -----------------
--
-- UPLOADED: the latest upload, replacement or agent submission of a document with this title on
-- this deal. Per-client files are logged as "<title> (<client>)", matched by prefix without LIKE so
-- an underscore or percent sign in a title cannot widen the match. Latest rather than first,
-- because the report describes the file the document holds now. Only documents that hold a file or
-- are Received are dated; a document renamed since its upload no longer matches and stays NULL.
UPDATE "documents" d
SET "uploaded_at" = u.at
FROM (
  SELECT d2.id, MAX(a.created_at) AS at
  FROM "documents" d2
  JOIN "audit_logs" a
    ON a.transaction_id = d2.transaction_id
   AND a.action IN ('Document uploaded', 'Document replaced', 'Document submitted')
   AND (a.field = d2.title OR left(a.field, length(d2.title) + 2) = d2.title || ' (')
  WHERE d2.deleted_at IS NULL
    AND (d2.file_path IS NOT NULL OR (d2.files IS NOT NULL AND d2.files NOT IN ('', '[]')) OR d2.status = 'Received')
  GROUP BY d2.id
) u
WHERE d.id = u.id;

-- REVIEWED: the latest time the validation was set to the value the document holds now. Only
-- Valid and Invalid are reviews; a Pending document has not been reviewed.
UPDATE "documents" d
SET "reviewed_at" = r.at
FROM (
  SELECT d2.id, MAX(a.created_at) AS at
  FROM "documents" d2
  JOIN "audit_logs" a
    ON a.transaction_id = d2.transaction_id
   AND a.action = 'Updated'
   AND a.field = d2.title || ' — Validation'
   AND a.new_value = d2.validation
  WHERE d2.deleted_at IS NULL
    AND d2.validation IN ('Valid', 'Invalid')
  GROUP BY d2.id
) r
WHERE d.id = r.id;
