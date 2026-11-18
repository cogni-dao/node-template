ALTER TABLE "link_transactions" DROP CONSTRAINT "link_transactions_provider_check";--> statement-breakpoint
ALTER TABLE "link_transactions" ADD CONSTRAINT "link_transactions_provider_check" CHECK ("link_transactions"."provider" IN ('github', 'discord', 'google', 'wallet'));--> statement-breakpoint
-- Hand-written below: triggers and functions are outside Drizzle's DDL scope (same as 0036).
-- AGENT_WALLET_IS_NOT_A_PAYEE replaces AGENTS_HOLD_NO_WALLET (0036). An agent principal may now bind a wallet (it is how an AI becomes an admin the DAO lists),
-- so the payout guard moves from "an agent has no wallet" to "no payout leaf resolves to an agent-owned wallet", enforced on both leaf tables.
DROP TRIGGER "agent_principals_no_wallet_binding" ON "user_bindings";--> statement-breakpoint
DROP FUNCTION agent_principals_refuse_wallet_binding();--> statement-breakpoint
CREATE OR REPLACE FUNCTION agent_wallet_is_not_a_payee()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM agent_principals ap
    WHERE ap.user_id IN (
      SELECT b.user_id FROM user_bindings b
      WHERE b.provider = 'wallet' AND lower(b.external_id) = NEW.account_lower
      UNION
      SELECT u.id FROM users u WHERE lower(u.wallet_address) = NEW.account_lower
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
