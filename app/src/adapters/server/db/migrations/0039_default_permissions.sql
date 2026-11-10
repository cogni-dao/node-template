-- Data, hand-written (same shape as 0037 / 0038): DEFAULT PERMISSIONS (task.5471).
-- A permission whose declaration names `onByDefaultFor: [<internal principal slug>]` is turned ON once at install, so a
-- fresh node's scorer and coordinator work before any admin opens the access page.
-- DEFAULT_PERMISSIONS_ARE_DECLARED: the declared pairs and the rows below must agree. A component test (default-permissions.int.test.ts)
-- compares the declarations (packages/ai-tools onByDefaultFor) with the rows this migration wrote, and fails CI when a
-- declared default has no row here, a row names an undeclared scope, or a principal is not seeded (0037).
-- Once only: each insert is skipped when ANY row ever exists for that principal and scope (live, pending or revoked), so an
-- admin's revoke sticks and a later migration never overrides a human decision. After install only an admin writes these rows.
-- approved_by is the system principal user (seeded by 0008): provenance only, it has no credential and never acts.
-- Order: 0037 (principals) first. A missing principal or system user RAISEs and aborts this migration's transaction.
-- To add a default: add the slug to the declaration, then add one marker block below in a NEW migration. Never edit this file after it ships.
-- To drop a default: delete the slug from the declaration and revoke the row in a new migration
-- (UPDATE agent_roles SET revoked_at = now() WHERE approved_by = system AND revoked_at IS NULL, for that principal and scope).
-- users has FORCE RLS (self_isolation): set the RLS context to the system principal (transaction-local) for the existence check.
SELECT set_config('app.current_user_id', '00000000-0000-4000-a000-000000000001', true);
--> statement-breakpoint
-- agent_roles is FORCE RLS with no policy for the owner: lift FORCE for these statements only (so the NOT EXISTS read sees
-- every row), inside the migration transaction, then restore it (0038 precedent).
ALTER TABLE "agent_roles" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- default-permission: prioritizer work_item:transition
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "users" WHERE "id" = '00000000-0000-4000-a000-000000000001') THEN
    RAISE EXCEPTION 'default permission: system user is not seeded (migration 0008 first)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "agent_principals" WHERE "kind" = 'internal' AND "slug" = 'prioritizer') THEN
    RAISE EXCEPTION 'default permission: internal principal "prioritizer" is not seeded (migration 0037 first)';
  END IF;
END
$$;
--> statement-breakpoint
-- default-permission: prioritizer work_item:transition
INSERT INTO "agent_roles" ("principal_user_id", "scope", "approved_by", "granted_at")
SELECT p."user_id", 'work_item:transition', '00000000-0000-4000-a000-000000000001', now()
FROM "agent_principals" p
WHERE p."kind" = 'internal' AND p."slug" = 'prioritizer'
  AND NOT EXISTS (SELECT 1 FROM "agent_roles" r WHERE r."principal_user_id" = p."user_id" AND r."scope" = 'work_item:transition');
--> statement-breakpoint
-- default-permission: node-ai schedule:manage
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "users" WHERE "id" = '00000000-0000-4000-a000-000000000001') THEN
    RAISE EXCEPTION 'default permission: system user is not seeded (migration 0008 first)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "agent_principals" WHERE "kind" = 'internal' AND "slug" = 'node-ai') THEN
    RAISE EXCEPTION 'default permission: internal principal "node-ai" is not seeded (migration 0037 first)';
  END IF;
END
$$;
--> statement-breakpoint
-- default-permission: node-ai schedule:manage
INSERT INTO "agent_roles" ("principal_user_id", "scope", "approved_by", "granted_at")
SELECT p."user_id", 'schedule:manage', '00000000-0000-4000-a000-000000000001', now()
FROM "agent_principals" p
WHERE p."kind" = 'internal' AND p."slug" = 'node-ai'
  AND NOT EXISTS (SELECT 1 FROM "agent_roles" r WHERE r."principal_user_id" = p."user_id" AND r."scope" = 'schedule:manage');
--> statement-breakpoint
ALTER TABLE "agent_roles" FORCE ROW LEVEL SECURITY;
