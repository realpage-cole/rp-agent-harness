-- ════════════════════════════════════════════════════════════════════════════
-- munder-difflin collaborative harness — Phase 4 schema (auth + workspace RLS).
--
-- Run this AFTER 0003 in the Supabase SQL editor (or `supabase db push`). It
-- closes the PROTOTYPE RLS hole: instead of the `anon` role being scoped only by
-- a guessable workspace_id string, every data table is now scoped to AUTHENTICATED
-- members of a workspace. The flow:
--     1. A user signs in (Supabase Auth, email/password) — handled in the MAIN
--        process by SyncManager (src/main/sync/auth.ts); the session never leaves
--        the main process.
--     2. The signed-in user CREATES a workspace (insert into public.workspaces,
--        returning its uuid-as-text id) or JOINS one (insert into
--        public.workspace_members for themself). The chosen id becomes the
--        client's `syncWorkspaceId`.
--     3. RLS on every data table now checks `is_workspace_member(workspace_id)`,
--        so a row is visible/writable only to members of that workspace.
--
-- ⚠️  SECURITY — RLS IS NOW LOCKED DOWN.
--     The data-table policies below are AUTHENTICATED-only and membership-scoped:
--     a row is readable/writable only by signed-in users who belong to its
--     workspace (via the SECURITY DEFINER helper `is_workspace_member`). The
--     prototype `anon` policies from 0001–0003 are DROPPED by name below. Deletes
--     remain denied everywhere (no DELETE policies → append-only / additive).
--
-- DESIGN DECISION: `workspace_id` stays TEXT everywhere (no destructive
-- text→uuid column migration on 0001–0003). Its VALUE is now a workspaces.id
-- (a uuid stored/compared as text). workspace_members.workspace_id is TEXT to
-- match the data tables.
--
-- Idempotency: this migration is re-runnable — every CREATE is guarded by a
-- DROP ... IF EXISTS (policies/functions) or CREATE ... IF NOT EXISTS (tables).
-- ════════════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;

-- ─── workspaces: one row per team (id is a uuid, stored as text) ─────────────
create table if not exists public.workspaces (
  id         text        primary key default gen_random_uuid()::text,
  name       text        not null,
  created_by uuid        not null references auth.users(id) default auth.uid(),
  created_at timestamptz          default now()
);

-- ─── workspace_members: which users belong to which workspace ────────────────
-- workspace_id is TEXT (matches the data tables + workspaces.id). A user joins a
-- workspace by inserting THEIR OWN row here (user_id = auth.uid()).
create table if not exists public.workspace_members (
  workspace_id text        not null references public.workspaces(id) on delete cascade,
  user_id      uuid        not null references auth.users(id) default auth.uid(),
  role         text        not null default 'member',
  created_at   timestamptz          default now(),
  primary key (workspace_id, user_id)
);

-- ─── is_workspace_member: SECURITY DEFINER membership check ───────────────────
-- SECURITY DEFINER (+ a pinned search_path) lets this read workspace_members
-- WITHOUT triggering RLS on that table — which avoids infinite recursion when the
-- workspace_members SELECT policy itself calls this helper.
drop function if exists public.is_workspace_member(text);
create function public.is_workspace_member(ws text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from workspace_members m
    where m.workspace_id = ws and m.user_id = auth.uid()
  )
$$;

-- ─── RLS: workspaces + workspace_members ─────────────────────────────────────
alter table public.workspaces        enable row level security;
alter table public.workspace_members enable row level security;

do $$
begin
  -- workspaces: members can read; any authenticated user can create one (and must
  -- stamp themselves as created_by); members can update their workspace.
  execute 'drop policy if exists workspaces_member_select on public.workspaces';
  execute 'create policy workspaces_member_select on public.workspaces
             for select to authenticated using (public.is_workspace_member(id))';

  execute 'drop policy if exists workspaces_auth_insert on public.workspaces';
  execute 'create policy workspaces_auth_insert on public.workspaces
             for insert to authenticated with check (created_by = auth.uid())';

  execute 'drop policy if exists workspaces_member_update on public.workspaces';
  execute 'create policy workspaces_member_update on public.workspaces
             for update to authenticated
             using (public.is_workspace_member(id))
             with check (public.is_workspace_member(id))';

  -- workspace_members: a user can read rows for workspaces they belong to, and can
  -- insert ONLY their own membership (user_id = auth.uid()) — the join path.
  execute 'drop policy if exists workspace_members_member_select on public.workspace_members';
  execute 'create policy workspace_members_member_select on public.workspace_members
             for select to authenticated using (public.is_workspace_member(workspace_id))';

  execute 'drop policy if exists workspace_members_self_insert on public.workspace_members';
  execute 'create policy workspace_members_self_insert on public.workspace_members
             for insert to authenticated with check (user_id = auth.uid())';
end $$;

-- ─── Data tables: DROP prototype anon policies + CREATE membership-scoped RLS ─
-- The data tables already have RLS enabled (0001–0003). Here we remove the
-- prototype `anon` policies BY NAME and replace them with authenticated,
-- membership-scoped ones. SELECT/INSERT for all 7 tables; UPDATE only for the
-- tables that had a prototype UPDATE policy (agent_memory, agents, tasks, board).
-- No DELETE policies anywhere → deletes stay denied.
do $$
declare t text;
begin
  -- Append-only tables (0001): had INSERT + SELECT prototype policies only.
  foreach t in array array['hive_log','cost_ledger','command_history'] loop
    execute format('drop policy if exists %I on public.%I', 'prototype_anon_insert_' || t, t);
    execute format('drop policy if exists %I on public.%I', 'prototype_anon_select_' || t, t);
  end loop;

  -- Upsert tables (0002 agent_memory, 0003 agents/tasks/board): had INSERT +
  -- SELECT + UPDATE prototype policies.
  foreach t in array array['agent_memory','agents','tasks','board'] loop
    execute format('drop policy if exists %I on public.%I', 'prototype_anon_insert_' || t, t);
    execute format('drop policy if exists %I on public.%I', 'prototype_anon_select_' || t, t);
    execute format('drop policy if exists %I on public.%I', 'prototype_anon_update_' || t, t);
  end loop;

  -- All 7 data tables: authenticated, membership-scoped SELECT + INSERT.
  foreach t in array array['hive_log','cost_ledger','command_history','agent_memory','agents','tasks','board'] loop
    execute format('drop policy if exists %I on public.%I', t || '_member_select', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.is_workspace_member(workspace_id))',
      t || '_member_select', t);

    execute format('drop policy if exists %I on public.%I', t || '_member_insert', t);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (public.is_workspace_member(workspace_id))',
      t || '_member_insert', t);
  end loop;

  -- Upsert tables: authenticated, membership-scoped UPDATE (the other half of upsert).
  foreach t in array array['agent_memory','agents','tasks','board'] loop
    execute format('drop policy if exists %I on public.%I', t || '_member_update', t);
    execute format(
      'create policy %I on public.%I for update to authenticated using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id))',
      t || '_member_update', t);
  end loop;
end $$;
