-- ════════════════════════════════════════════════════════════════════════════
-- rp-agent-harness collaborative harness — Phase 2 schema (agent-memory sync).
--
-- Run this AFTER 0001 in the Supabase SQL editor (or `supabase db push`). It adds
-- the single table SyncManager (src/main/sync/memory.ts) syncs TWO-WAY:
--     <home>/hive/agents/<id>/memory.md        → public.agent_memory   (push)
--     public.agent_memory (teammates' rows)    → <home>/hive/mirror/agents/<id>/memory.md (pull)
--
-- One agent lives on exactly one machine, so there is NO merge: the row is keyed
-- on (workspace_id, agent_id) and last-write-wins via `updated_at` (ms epoch). The
-- client de-dups pushes on `content_hash` (sha1 of the body) and pulls only rows
-- authored by OTHER machines (machine_id != self) newer than its local cursor.
--
-- ⚠️  SECURITY — PROTOTYPE POSTURE (hosted supabase.com, no auth yet).
--     The RLS policies below allow the `anon` role to INSERT, SELECT and UPDATE
--     scoped only by a workspace_id string anyone holding the anon key could
--     guess. (Phase 1 was append-only; agent memory needs UPDATE for the upsert.)
--     This is fine for a proof-of-concept on a throwaway project. It is NOT safe
--     for real RealPage-internal memory. Phase 4 replaces these with Supabase
--     Auth + a `workspaces`/`workspace_members` model and membership-scoped RLS,
--     and the deployment moves to approved internal/self-hosted infra.
--
--     Until then: use a non-sensitive project, and rotate the anon key freely.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── agent_memory: latest memory.md per agent (one agent = one machine) ──────
create table if not exists public.agent_memory (
  workspace_id text        not null,        -- Phase 4: uuid fk → workspaces.id
  agent_id     text        not null,        -- the hive agent id (stable per agent)
  machine_id   text        not null,        -- authoring machine; pull skips own rows
  name         text,                        -- cosmetic display name (from registry.json)
  body         text        not null,        -- the full memory.md contents
  content_hash text        not null,        -- sha1(body); client de-dups pushes on this
  updated_at   bigint      not null,        -- ms epoch; last-write-wins / pull cursor
  created_at   timestamptz not null default now(),
  primary key (workspace_id, agent_id)
);
create index if not exists idx_agent_memory_ws_updated on public.agent_memory (workspace_id, updated_at desc);

-- ─── RLS (PROTOTYPE — see the security banner above) ─────────────────────────
alter table public.agent_memory enable row level security;

-- INSERT + UPDATE (the two halves of the client's upsert) + SELECT so teammates
-- can pull each other's memory. No DELETE policy → deletes are denied.
do $$
begin
  execute 'create policy prototype_anon_insert_agent_memory on public.agent_memory for insert to anon with check (true)';
  execute 'create policy prototype_anon_select_agent_memory on public.agent_memory for select to anon using (true)';
  execute 'create policy prototype_anon_update_agent_memory on public.agent_memory for update to anon using (true) with check (true)';
end $$;
