-- ONE_WALLET_ONE_KEY: a wallet is keyed by its lowercase address. Normalize existing wallet bindings before the unique index exists.
-- user_bindings has FORCE RLS (tenant_isolation) and the migrating role sees no tenant, so lift FORCE for this step only (precedent: 0037); it runs inside
-- the migration transaction, so no other session sees it.
ALTER TABLE "user_bindings" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- NO_AUTO_MERGE: two owners of one wallet that differ only in case are never merged silently. Fail loudly and list the colliding rows.
DO $$
DECLARE
  collisions text;
BEGIN
  SELECT string_agg(format('%s => binding ids/users: %s', key, owners), '; ')
    INTO collisions
  FROM (
    SELECT lower(external_id) AS key,
           string_agg(id || ' (user ' || user_id || ', ' || external_id || ')', ', ') AS owners
    FROM "user_bindings"
    WHERE provider = 'wallet'
    GROUP BY lower(external_id)
    HAVING count(*) > 1
  ) c;
  IF collisions IS NOT NULL THEN
    RAISE EXCEPTION 'wallet bindings collide after lowercasing; resolve by hand, no owner is merged automatically: %', collisions;
  END IF;
END
$$;--> statement-breakpoint
UPDATE "user_bindings" SET external_id = lower(external_id) WHERE provider = 'wallet' AND external_id <> lower(external_id);--> statement-breakpoint
ALTER TABLE "user_bindings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "link_transactions" DROP CONSTRAINT "link_transactions_provider_check";--> statement-breakpoint
ALTER TABLE "link_transactions" ADD CONSTRAINT "link_transactions_provider_check" CHECK ("link_transactions"."provider" IN ('github', 'discord', 'google', 'wallet'));--> statement-breakpoint
CREATE UNIQUE INDEX "user_bindings_wallet_lower_unique" ON "user_bindings" USING btree ("provider",lower("external_id")) WHERE "user_bindings"."provider" = 'wallet';
--> statement-breakpoint
-- Hand-written below: triggers and functions are outside Drizzle's DDL scope (same as 0036).
-- AGENT_WALLET_IS_NOT_A_PAYEE replaces AGENTS_HOLD_NO_WALLET (0036). An agent principal may now bind a wallet (it is how an AI becomes an admin the DAO lists),
-- so the payout guard moves from "an agent has no wallet" to "no payout leaf resolves to an agent-owned wallet", enforced on both leaf tables.
-- The function is NOT security definer: leaf rows are written by the BYPASSRLS service role, so the invoker sees users and user_bindings in full.
-- (A definer owned by the RLS-subject migrating role would see zero rows and never fire.)
DROP TRIGGER "agent_principals_no_wallet_binding" ON "user_bindings";--> statement-breakpoint
DROP FUNCTION agent_principals_refuse_wallet_binding();--> statement-breakpoint
CREATE OR REPLACE FUNCTION agent_wallet_is_not_a_payee()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM agent_principals ap
    WHERE ap.user_id IN (
      SELECT b.user_id FROM user_bindings b
      WHERE b.provider = 'wallet' AND lower(b.external_id) = lower(NEW.account_lower)
      UNION
      SELECT u.id FROM users u WHERE lower(u.wallet_address) = lower(NEW.account_lower)
    )
  ) THEN
    RAISE EXCEPTION 'wallet % belongs to an agent principal and cannot be a payee', NEW.account_lower
      USING ERRCODE = 'check_violation', CONSTRAINT = 'agent_wallet_is_not_a_payee';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "epoch_distribution_leaves_agent_wallet_is_not_a_payee"
  BEFORE INSERT ON "epoch_distribution_leaves"
  FOR EACH ROW EXECUTE FUNCTION agent_wallet_is_not_a_payee();--> statement-breakpoint
CREATE TRIGGER "distribution_settlement_leaves_agent_wallet_is_not_a_payee"
  BEFORE INSERT ON "distribution_settlement_leaves"
  FOR EACH ROW EXECUTE FUNCTION agent_wallet_is_not_a_payee();
