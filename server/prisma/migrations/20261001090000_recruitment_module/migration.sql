-- Recruitment & Interview: candidates, their interviews, and the history of both.
--
-- A CANDIDATE IS NOT AN ACCOUNT, and these tables exist so that distinction survives. Nothing here
-- grants access to anything: `agent_user_id` stays null until an administrator approves the person
-- and creates the account deliberately, and the candidate row remains afterwards as the record of
-- how that account came to exist.
--
-- USERS ARE REFERENCED BY ID WITH NO FOREIGN KEY, which is what `lead_tasks.assigned_to` already
-- does. A recruiter or interviewer who later leaves must not cascade a candidate's history away,
-- and that history is the reason for keeping the record at all.
--
-- CANDIDATE STATUS AND INTERVIEW STATUS ARE SEPARATE COLUMNS ON SEPARATE TABLES, deliberately. One
-- candidate may sit through several interviews, each with its own outcome, and a recommendation
-- from any of them is advice rather than the brokerage's decision.

CREATE TABLE "recruitment_candidates" (
    "id"                     SERIAL       PRIMARY KEY,
    "name"                   VARCHAR(255) NOT NULL,
    "email"                  VARCHAR(255) NOT NULL,
    "phone"                  VARCHAR(64),
    "location"               VARCHAR(255),
    -- referral | website | walk-in | agency | other
    "source"                 VARCHAR(32),
    "referred_by_user_id"    INTEGER,
    "assigned_recruiter_id"  INTEGER,
    -- new | contacted | interview | approved | onboarding | active | hold | not_selected
    "status"                 VARCHAR(24)  NOT NULL DEFAULT 'new',
    -- The recruiter's RECOMMENDATION: approved | hold | not_selected. Advice, not a decision.
    "recommendation"         VARCHAR(16),
    "recommended_by_user_id" INTEGER,
    "recommended_at"         TIMESTAMP(0),
    "approved_by_user_id"    INTEGER,
    "approved_at"            TIMESTAMP(0),
    -- The account created FROM this candidate. UNIQUE, so a second account can never be created
    -- from the same person: the duplicate guard belongs to the database, not to a check somebody
    -- could forget to write or could lose to two requests arriving together.
    "agent_user_id"          INTEGER,
    "activated_at"           TIMESTAMP(0),
    "created_by"             VARCHAR(255),
    "created_at"             TIMESTAMP(0),
    "updated_at"             TIMESTAMP(0),
    "deleted_at"             TIMESTAMP(0)
);

CREATE UNIQUE INDEX "recruitment_candidates_agent_user_id_key" ON "recruitment_candidates"("agent_user_id");
CREATE INDEX "recruitment_candidates_status_idx"                ON "recruitment_candidates"("status");
CREATE INDEX "recruitment_candidates_assigned_recruiter_id_idx"  ON "recruitment_candidates"("assigned_recruiter_id");
CREATE INDEX "recruitment_candidates_referred_by_user_id_idx"    ON "recruitment_candidates"("referred_by_user_id");
CREATE INDEX "recruitment_candidates_email_idx"                  ON "recruitment_candidates"("email");
CREATE INDEX "recruitment_candidates_deleted_at_idx"             ON "recruitment_candidates"("deleted_at");

CREATE TABLE "recruitment_interviews" (
    "id"             SERIAL       PRIMARY KEY,
    "candidate_id"   INTEGER      NOT NULL,
    "interviewer_id" INTEGER,
    "scheduled_at"   TIMESTAMP(0),
    -- scheduled | completed | approved | hold | not_selected  (THE INTERVIEW'S, never the person's)
    "status"         VARCHAR(16)  NOT NULL DEFAULT 'scheduled',
    "mode"           VARCHAR(16),
    "location"       VARCHAR(255),
    "feedback"       TEXT,
    "created_by"     VARCHAR(255),
    "created_at"     TIMESTAMP(0),
    "updated_at"     TIMESTAMP(0),
    CONSTRAINT "recruitment_interviews_candidate_id_fkey" FOREIGN KEY ("candidate_id")
        REFERENCES "recruitment_candidates"("id") ON DELETE CASCADE ON UPDATE RESTRICT
);

CREATE INDEX "recruitment_interviews_candidate_id_idx"   ON "recruitment_interviews"("candidate_id");
CREATE INDEX "recruitment_interviews_status_idx"         ON "recruitment_interviews"("status");
CREATE INDEX "recruitment_interviews_interviewer_id_idx" ON "recruitment_interviews"("interviewer_id");
CREATE INDEX "recruitment_interviews_scheduled_at_idx"   ON "recruitment_interviews"("scheduled_at");

CREATE TABLE "recruitment_notes" (
    "id"           SERIAL  PRIMARY KEY,
    "candidate_id" INTEGER NOT NULL,
    "body"         TEXT    NOT NULL,
    "author"       VARCHAR(255),
    "user_id"      INTEGER,
    "created_at"   TIMESTAMP(0),
    CONSTRAINT "recruitment_notes_candidate_id_fkey" FOREIGN KEY ("candidate_id")
        REFERENCES "recruitment_candidates"("id") ON DELETE CASCADE ON UPDATE RESTRICT
);

CREATE INDEX "recruitment_notes_candidate_id_idx" ON "recruitment_notes"("candidate_id");

CREATE TABLE "recruitment_followups" (
    "id"           SERIAL       PRIMARY KEY,
    "candidate_id" INTEGER      NOT NULL,
    "due_at"       TIMESTAMP(0) NOT NULL,
    "title"        VARCHAR(255) NOT NULL,
    "done_at"      TIMESTAMP(0),
    "assigned_to"  INTEGER,
    "created_by"   VARCHAR(255),
    "created_at"   TIMESTAMP(0),
    "updated_at"   TIMESTAMP(0),
    CONSTRAINT "recruitment_followups_candidate_id_fkey" FOREIGN KEY ("candidate_id")
        REFERENCES "recruitment_candidates"("id") ON DELETE CASCADE ON UPDATE RESTRICT
);

CREATE INDEX "recruitment_followups_candidate_id_idx" ON "recruitment_followups"("candidate_id");
CREATE INDEX "recruitment_followups_due_at_idx"       ON "recruitment_followups"("due_at");

-- A row with no `file_path` is a REQUEST -- the recruiter asking for something -- which is why the
-- file is nullable rather than the row only existing once something has been uploaded.
CREATE TABLE "recruitment_documents" (
    "id"           SERIAL       PRIMARY KEY,
    "candidate_id" INTEGER      NOT NULL,
    "name"         VARCHAR(255) NOT NULL,
    "file_path"    VARCHAR(512),
    "file_name"    VARCHAR(255),
    "requested_at" TIMESTAMP(0),
    "uploaded_at"  TIMESTAMP(0),
    "uploaded_by"  VARCHAR(255),
    "created_at"   TIMESTAMP(0),
    "updated_at"   TIMESTAMP(0),
    CONSTRAINT "recruitment_documents_candidate_id_fkey" FOREIGN KEY ("candidate_id")
        REFERENCES "recruitment_candidates"("id") ON DELETE CASCADE ON UPDATE RESTRICT
);

CREATE INDEX "recruitment_documents_candidate_id_idx" ON "recruitment_documents"("candidate_id");

CREATE TABLE "recruitment_onboarding_items" (
    "id"           SERIAL       PRIMARY KEY,
    "candidate_id" INTEGER      NOT NULL,
    "title"        VARCHAR(255) NOT NULL,
    "position"     INTEGER      NOT NULL DEFAULT 0,
    "done_at"      TIMESTAMP(0),
    "done_by"      VARCHAR(255),
    "created_at"   TIMESTAMP(0),
    "updated_at"   TIMESTAMP(0),
    CONSTRAINT "recruitment_onboarding_items_candidate_id_fkey" FOREIGN KEY ("candidate_id")
        REFERENCES "recruitment_candidates"("id") ON DELETE CASCADE ON UPDATE RESTRICT
);

CREATE INDEX "recruitment_onboarding_items_candidate_id_idx" ON "recruitment_onboarding_items"("candidate_id");

-- Its own table rather than `audit_logs`, which is keyed on `transaction_id` and belongs to the
-- Transaction Desk. A candidate is neither a transaction nor a lead, and borrowing that table would
-- mean writing either a null key or a fabricated one.
CREATE TABLE "recruitment_events" (
    "id"           SERIAL      PRIMARY KEY,
    "candidate_id" INTEGER     NOT NULL,
    "action"       VARCHAR(32) NOT NULL,
    "detail"       TEXT,
    "actor_name"   VARCHAR(255),
    "actor_id"     INTEGER,
    "created_at"   TIMESTAMP(0),
    CONSTRAINT "recruitment_events_candidate_id_fkey" FOREIGN KEY ("candidate_id")
        REFERENCES "recruitment_candidates"("id") ON DELETE CASCADE ON UPDATE RESTRICT
);

CREATE INDEX "recruitment_events_candidate_id_idx" ON "recruitment_events"("candidate_id");
CREATE INDEX "recruitment_events_created_at_idx"   ON "recruitment_events"("created_at");
