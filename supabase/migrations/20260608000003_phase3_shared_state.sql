-- ════════════════════════════════════════════════════════════════════════════
-- munder-difflin collaborative harness — Phase 3 schema (shared-state sync).
--
-- Run this AFTER 0002 in the Supabase SQL editor (or `supabase db push`). It adds
-- the three tables SyncManager (src/main/sync/state.ts) syncs across teammates'
-- machines so the hive's shared state is the same on every machine:
--     <home>/hive/registry.json  ←→  public.agents   (the agent roster)
--     <home>/hive/tasks.json     ←→  public.tasks     (the kanban ledger)
--     <home>/hive/board.md       ←→  public.board     (the shared blackboard)
--
-- PUSH rides the 60s SyncManager beat (upsert). PULL is Supabase Realtime
-- (postgres_changes) PLUS a 30s catch-up poll (realtime can drop events). The
-- conflict policy is LAST-WRITER-WINS by `updated_at` (ms epoch) and ADDITIVE:
-- the client NEVER deletes a local row on pull, and a remote row overwrites a
-- local one ONLY if `remote.updated_at` is strictly newer. There are therefore
-- no DELETE policies below — deletes are denied.
--
-- ⚠️  SECURITY — PROTOTYPE POSTURE (hosted supabase.com, no auth yet).
--     The RLS policies below allow the `anon` role to INSERT, SELECT and UPDATE
--     scoped only by a workspace_id string anyone holding the anon key could
--     guess. This is fine for a proof-of-concept on a throwaway project. It is
--     NOT safe for real RealPage-internal state. Phase 4 replaces these with
--     Supabase Auth + a `workspaces`/`workspace_members` model and
--     membership-scoped RLS, turns `workspace_id` into a uuid fk, and moves the
--     deployment to approved internal/self-hosted infra.
--
--     Until then: use a non-sensitive project, and rotate the anon key freely.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── agents: the hive roster (one row per registry agent) ────────────────────
create table if not exists public.agents (
  workspace_id text        not null,        -- Phase 4: uuid fk → workspaces.id
  agent_id     text        not null,        -- the hive agent id (stable per agent)
  machine_id   text        not null,        -- authoring machine
  name         text,
  role         text,
  status       text,                        -- idle | working | blocked | gone
  cwd          text,
  is_god       boolean,
  archived     boolean,
  last_seen    bigint,                      -- ms epoch the agent was last seen
  updated_at   bigint      not null,        -- ms epoch; last-write-wins / pull cursor
  created_at   timestamptz not null default now(),
  primary key (workspace_id, agent_id)
);
create index if not exists idx_agents_ws_updated on public.agents (workspace_id, updated_at desc);

-- ─── tasks: the structured kanban ledger (one row per task) ──────────────────
create table if not exists public.tasks (
  workspace_id text        not null,        -- Phase 4: uuid fk → workspaces.id
  task_id      text        not null,        -- the task's stable id
  payload      jsonb       not null,        -- the whole task object (round-trips intact)
  status       text,                        -- todo | doing | blocked | done
  assignee     text,                        -- worker agent id (sticky once dispatched)
  updated_by   text,                        -- who last touched the card
  updated_at   bigint      not null,        -- ms epoch; last-write-wins / pull cursor
  created_at   timestamptz not null default now(),
  primary key (workspace_id, task_id)
);
create index if not exists idx_tasks_ws_updated on public.tasks (workspace_id, updated_at desc);

-- ─── board: the shared blackboard (one row per workspace) ────────────────────
create table if not exists public.board (
  workspace_id text        primary key,     -- Phase 4: uuid fk → workspaces.id
  body         text        not null,        -- the full board.md contents
  updated_by   text,                        -- who last scribed the board
  updated_at   bigint      not null,        -- ms epoch; last-write-wins
  created_at   timestamptz not null default now()
);

-- ─── RLS (PROTOTYPE — see the security banner above) ─────────────────────────
-- INSERT + UPDATE (the two halves of the client's upsert) + SELECT so teammates
-- can pull each other's state. No DELETE policy → deletes are denied (ADDITIVE).
alter table public.agents enable row level security;
alter table public.tasks  enable row level security;
alter table public.board  enable row level security;

do $$
begin
  execute 'create policy prototype_anon_insert_agents on public.agents for insert to anon with check (true)';
  execute 'create policy prototype_anon_select_agents on public.agents for select to anon using (true)';
  execute 'create policy prototype_anon_update_agents on public.agents for update to anon using (true) with check (true)';

  execute 'create policy prototype_anon_insert_tasks on public.tasks for insert to anon with check (true)';
  execute 'create policy prototype_anon_select_tasks on public.tasks for select to anon using (true)';
  execute 'create policy prototype_anon_update_tasks on public.tasks for update to anon using (true) with check (true)';

  execute 'create policy prototype_anon_insert_board on public.board for insert to anon with check (true)';
  execute 'create policy prototype_anon_select_board on public.board for select to anon using (true)';
  execute 'create policy prototype_anon_update_board on public.board for update to anon using (true) with check (true)';
end $$;
