-- Team chat mentions.
--
-- WHY A COLUMN OF USER IDS RATHER THAN PARSING NAMES AT READ TIME. "@John" is ambiguous the moment a
-- brokerage employs two Johns, and guessing wrong does not fail loudly — it tells the wrong person
-- about a deal. The client resolves the name to a person as it is typed and sends the id; the server
-- re-checks that id against who may open the deal. The stored value is therefore a decision, not a
-- guess that has to be re-made every time the message is rendered.
--
-- JSON rather than a join table because nothing queries it in reverse. The only questions asked are
-- "who does this message mention" (to notify, and to highlight when rendering) — both keyed by the
-- message. A "mentions of me" feed would justify a table; there isn't one, and inventing the schema
-- for a screen nobody has asked for is how tables end up half-maintained.
ALTER TABLE "transaction_messages"
    ADD COLUMN "mentions" TEXT;
