-- agent_credentials: the SQL TAIL for the revocable agent keys (`@cogni-dao/agent-grants/credentials`). The table part is NOT here: `defineAgentAuthoritySchema`
-- owns it and the node's own `db:generate` writes it. Append this file after that generated SQL (and after `agent_authority.sql`: the trigger reads `agent_principals`).
-- node-template keeps it as 0039 + 0040 (`agent_credentials` rows belong only to a user with an `external` principal row).
-- FORCE RLS, a function and a trigger are outside Drizzle's DDL scope.
-- agent_credentials has NO policy: ENABLE + FORCE = deny-all for the app role. Only the BYPASSRLS service role reads or writes it.
ALTER TABLE "agent_credentials" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- STATE_IS_DERIVED: the one derivation of a credential's state from its timestamps, against the DATABASE clock. Never stored.
CREATE OR REPLACE FUNCTION agent_credential_state(c agent_credentials)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN c.revoked_at IS NOT NULL THEN 'revoked'
    WHEN c.confirmed_at IS NULL THEN CASE WHEN c.pending_expires_at > now() THEN 'pending' ELSE 'pending_expired' END
    WHEN c.expires_at > now() THEN 'active'
    WHEN c.renew_until > now() THEN 'renew_only'
    ELSE 'expired'
  END
$$;--> statement-breakpoint
-- CREDENTIALS_ONLY_ON_AGENT_PRINCIPALS: a credential may belong only to a user with an EXTERNAL agent_principals row. An internal
-- principal (this node's AI) never holds a key, and a plain user has no agent row until `upgrade` writes one.
CREATE OR REPLACE FUNCTION agent_credentials_require_external_principal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM agent_principals ap WHERE ap.user_id = NEW.user_id AND ap.kind = 'external') THEN
    RAISE EXCEPTION 'agent credential for % requires an external agent principal', NEW.user_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'agent_credentials_external_principal_only';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "agent_credentials_external_principal_only"
  BEFORE INSERT OR UPDATE OF user_id ON "agent_credentials"
  FOR EACH ROW EXECUTE FUNCTION agent_credentials_require_external_principal();
