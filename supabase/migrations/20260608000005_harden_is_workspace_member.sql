-- ════════════════════════════════════════════════════════════════════════════
-- rp-agent-harness collaborative harness — harden the is_workspace_member helper.
--
-- Run AFTER 0004. The Supabase security advisor flags SECURITY DEFINER functions
-- that are RPC-callable by `anon` (0028). is_workspace_member is only needed by
-- the RLS policies, which evaluate as the AUTHENTICATED user — so the anon/public
-- EXECUTE grant is unnecessary surface. Revoke it; keep EXECUTE for authenticated
-- (RLS would break without it).
--
-- (The remaining advisor note — authenticated can also RPC-call it — is benign for
-- a boolean membership check: a signed-in user can only probe THEIR OWN
-- memberships. Fully silencing it would mean moving the function to a non-exposed
-- schema and rewiring every policy; not worth it here.)
-- ════════════════════════════════════════════════════════════════════════════

revoke execute on function public.is_workspace_member(text) from public, anon;
grant  execute on function public.is_workspace_member(text) to authenticated;
