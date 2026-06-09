-- ════════════════════════════════════════════════════════════════════════════
-- Fix: creating/joining a workspace failed with "new row violates row-level
-- security policy". ROOT CAUSE (found via DB-level simulation, not the client):
-- PostgREST returns the inserted row by default, so INSERT also evaluates the
-- table's SELECT policy on the NEW row. The 0004 SELECT policies were:
--     workspaces.workspaces_member_select          USING is_workspace_member(id)
--     workspace_members.*_member_select            USING is_workspace_member(workspace_id)
-- At create time the creator is NOT yet a member (membership is a SECOND insert),
-- so is_workspace_member() is false → the returning-SELECT denies the row →
-- the whole INSERT aborts. (The INSERT WITH CHECK itself was always correct.)
--
-- FIX: also let a user SELECT rows they demonstrably own — their own workspace
-- (created_by = auth.uid()) and their own membership rows (user_id = auth.uid()).
-- Cross-member visibility still flows through is_workspace_member(). Run AFTER 0004.
-- ════════════════════════════════════════════════════════════════════════════

drop policy if exists workspaces_member_select on public.workspaces;
create policy workspaces_member_select on public.workspaces
  for select to authenticated
  using (public.is_workspace_member(id) or created_by = auth.uid());

drop policy if exists workspace_members_member_select on public.workspace_members;
create policy workspace_members_member_select on public.workspace_members
  for select to authenticated
  using (user_id = auth.uid() or public.is_workspace_member(workspace_id));
