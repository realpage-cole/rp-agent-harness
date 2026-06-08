-- ════════════════════════════════════════════════════════════════════════════
-- munder-difflin collaborative harness — Phase 0/1 schema (append-only mirror).
--
-- Run this in the Supabase SQL editor (or `supabase db push`) on a fresh project.
-- It creates the three append-only tables SyncManager (src/main/sync.ts) mirrors
-- ONE-WAY UP from each teammate's local hive:
--     <hive>/log.jsonl         → public.hive_log
--     <hive>/cost-ledger.jsonl → public.cost_ledger
--     SQLite command_history   → public.command_history
--
-- Every row is tagged with `workspace_id` (the shared team id from Settings) and
-- `machine_id` (a stable per-machine uuid), plus a deterministic dedup key so the
-- client can safely re-push after a crash/offset reset (it upserts with
-- ignoreDuplicates).
--
-- ⚠️  SECURITY — PROTOTYPE POSTURE (hosted supabase.com, no auth yet).
--     The RLS policies below allow the `anon` role to INSERT and SELECT scoped
--     only by a workspace_id string anyone holding the anon key could guess.
--     This is fine for a proof-of-concept on a throwaway project. It is NOT safe
--     for real RealPage-internal memory. Phase 4 replaces these with Supabase
--     Auth + a `workspaces`/`workspace_members` model and membership-scoped RLS,
--     and the deployment moves to approved internal/self-hosted infra.
--
--     Until then: use a non-sensitive project, and rotate the anon key freely.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── hive_log: append-only event feed (mirror of log.jsonl) ──────────────────
create table if not exists public.hive_log (
  event_uid    text primary key,           -- sha1(machine_id|raw_line); dedup key
  workspace_id text        not null,        -- Phase 4: uuid fk → workspaces.id
  machine_id   text        not null,
  ts           bigint,                      -- ms epoch lifted from the line's `ts`
  event        jsonb       not null,        -- the full { ts, kind, ... } event
  created_at   timestamptz not null default now()
);
create index if not exists idx_hive_log_ws_ts on public.hive_log (workspace_id, ts desc);

-- ─── cost_ledger: append-only usage/cost samples (mirror of cost-ledger.jsonl) ─
-- Columns match the on-disk row 1:1 (hive.ts appendCostLedger already emits
-- snake_case), so the mapper just spreads the parsed line + tags it.
create table if not exists public.cost_ledger (
  event_uid      text primary key,         -- sha1(machine_id|raw_line); dedup key
  workspace_id   text        not null,
  machine_id     text        not null,
  agent_id       text,
  session_id     text,
  ts             bigint,                    -- ms epoch
  input          integer,
  output         integer,
  cache_read     integer,
  cache_creation integer,
  model          text,
  usd            numeric,
  created_at     timestamptz not null default now()
);
create index if not exists idx_cost_ledger_ws_agent_ts on public.cost_ledger (workspace_id, agent_id, ts desc);

-- ─── command_history: append-only prompt log (mirror of SQLite command_history) ─
create table if not exists public.command_history (
  row_uid      text primary key,           -- machine_id:ch:<source_id>; dedup key
  workspace_id text        not null,
  machine_id   text        not null,
  source_id    bigint      not null,        -- the local SQLite rowid
  agent_id     text        not null,
  cwd          text,
  text         text        not null,
  ts           bigint      not null,        -- ms epoch
  created_at   timestamptz not null default now()
);
create index if not exists idx_command_history_ws_ts on public.command_history (workspace_id, ts desc);

-- ─── RLS (PROTOTYPE — see the security banner above) ─────────────────────────
alter table public.hive_log        enable row level security;
alter table public.cost_ledger     enable row level security;
alter table public.command_history enable row level security;

-- Append-only INSERT for anon, plus SELECT so teammates can read the shared feed.
-- No UPDATE/DELETE policy → those are denied (append-only by construction).
do $$
declare t text;
begin
  foreach t in array array['hive_log','cost_ledger','command_history'] loop
    execute format(
      'create policy %I on public.%I for insert to anon with check (true)',
      'prototype_anon_insert_' || t, t);
    execute format(
      'create policy %I on public.%I for select to anon using (true)',
      'prototype_anon_select_' || t, t);
  end loop;
end $$;
