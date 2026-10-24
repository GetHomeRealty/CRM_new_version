-- Invoice Settings: default Terms & Conditions and default signature, copied onto each new invoice.
ALTER TABLE "company_settings" ADD COLUMN "invoice_terms_conditions" TEXT;
ALTER TABLE "company_settings" ADD COLUMN "invoice_signature" TEXT;
