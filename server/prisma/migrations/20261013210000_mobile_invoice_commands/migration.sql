ALTER TABLE invoices ADD COLUMN mobile_create_request_id uuid, ADD COLUMN mobile_create_fingerprint varchar(64);
CREATE UNIQUE INDEX invoices_created_by_mobile_create_request_id_key ON invoices(created_by,mobile_create_request_id);
ALTER TABLE invoice_payments ADD COLUMN mobile_request_id uuid, ADD COLUMN mobile_fingerprint varchar(64);
CREATE UNIQUE INDEX invoice_payments_invoice_id_mobile_request_id_key ON invoice_payments(invoice_id,mobile_request_id);
CREATE TABLE mobile_invoice_mail_receipts (
 id serial PRIMARY KEY,
 owner_user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 invoice_id integer NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
 request_id uuid NOT NULL,
 event varchar(16) NOT NULL CHECK(event IN ('send','reminder')),
 version varchar(64) NOT NULL,
 status varchar(16) NOT NULL CHECK(status IN ('sending','sent','uncertain')),
 created_at timestamptz(3) NOT NULL DEFAULT now(), updated_at timestamptz(3) NOT NULL DEFAULT now(),
 UNIQUE(owner_user_id,request_id)
);
CREATE INDEX mobile_invoice_mail_receipts_invoice_id_idx ON mobile_invoice_mail_receipts(invoice_id);
