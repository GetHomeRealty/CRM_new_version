-- TD-159 slice 3 - remember when a person, rather than the brokerage checklist, decided
-- that a document is Mandatory on one particular deal.
--
-- NULLABLE AND NULL EVERYWHERE ON DAY ONE. Every existing row keeps its Mandatory flag
-- exactly as it is; this column only records decisions made from now on, so nothing about
-- any deal changes the moment it ships.
ALTER TABLE "documents" ADD COLUMN "mandatory_override" BOOLEAN;
