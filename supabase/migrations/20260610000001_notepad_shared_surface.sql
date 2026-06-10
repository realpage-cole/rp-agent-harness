-- ════════════════════════════════════════════════════════════════════════════
-- Notepad — the shared "team surface" backing the dashboard's center-panel
-- Notepad view. Three workspace-scoped tables, all membership-gated via the
-- existing public.is_workspace_member(ws) helper (same posture as agents/tasks/
-- board/memory_chunks):
--
--   public.member_notes  — TEAM PULSE. One row per owner machine: each teammate's
--     short "what I'm up to" status, pushed from <hive>/pulse.md on the sync beat
--     (per-owner; never merged). A teammate's pulse is read live by listMemberNotes.
--   public.shared_agents — AGENT LIBRARY. A shared catalog of agent definitions a
--     teammate can publish so others can one-click "Add to my hive". Written
--     immediately by publishAgent/unpublishAgent (not on the beat); read live.
--   public.resources     — PINNED LINKS. A shared list of useful URLs. Written
--     immediately by addResource/removeResource; read live.
--
-- member_notes + shared_agents are NOT added to the realtime publication — a
-- catch-up poll / on-demand list read covers them.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── member_notes: TEAM PULSE (per-owner machine) ────────────────────────────
create table if not exists public.member_notes (
  workspace_id text        not null,        -- workspaces.id (membership-scoped)
  machine_id   text        not null,        -- authoring machine (the owner)
  owner_label  text,                        -- owner email, for attribution in the UI
  body         text        not null default '',
  updated_at   bigint      not null,        -- ms epoch; last-write-wins per owner
  created_at   timestamptz not null default now(),
  primary key (workspace_id, machine_id)
);
create index if not exists idx_member_notes_ws on public.member_notes (workspace_id);

-- ─── shared_agents: AGENT LIBRARY (shared catalog) ───────────────────────────
create table if not exists public.shared_agents (
  workspace_id   text        not null,      -- workspaces.id (membership-scoped)
  identity_id    text        not null,      -- random uuid; the catalog entry id
  author_label   text,                      -- publisher email, for attribution
  author_machine text,                      -- publisher machine id
  name           text        not null,
  role           text,
  capabilities   text[],
  model          text,
  accent         text,
  custom_prompt  text,
  why            text,                      -- the "why publish this" blurb
  updated_at     bigint      not null,      -- ms epoch
  created_at     timestamptz not null default now(),
  primary key (workspace_id, identity_id)
);
create index if not exists idx_shared_agents_ws on public.shared_agents (workspace_id);

-- ─── resources: PINNED LINKS (shared) ────────────────────────────────────────
create table if not exists public.resources (
  workspace_id text        not null,        -- workspaces.id (membership-scoped)
  resource_id  text        not null,        -- random uuid; the pin id
  label        text        not null,
  url          text        not null,
  note         text,
  author_label text,                        -- publisher email, for attribution
  updated_at   bigint      not null,        -- ms epoch
  created_at   timestamptz not null default now(),
  primary key (workspace_id, resource_id)
);
create index if not exists idx_resources_ws on public.resources (workspace_id);

-- ─── RLS — membership-scoped, identical posture to agents/tasks/memory_chunks ─
-- A workspace member may read the whole workspace's rows (that IS the shared
-- surface) and insert/update/delete them (each client only ever writes its own,
-- but RLS need only gate the workspace).
alter table public.member_notes  enable row level security;
alter table public.shared_agents enable row level security;
alter table public.resources     enable row level security;

drop policy if exists member_notes_select on public.member_notes;
create policy member_notes_select on public.member_notes
  for select using (public.is_workspace_member(workspace_id));
drop policy if exists member_notes_insert on public.member_notes;
create policy member_notes_insert on public.member_notes
  for insert with check (public.is_workspace_member(workspace_id));
drop policy if exists member_notes_update on public.member_notes;
create policy member_notes_update on public.member_notes
  for update using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
drop policy if exists member_notes_delete on public.member_notes;
create policy member_notes_delete on public.member_notes
  for delete using (public.is_workspace_member(workspace_id));

drop policy if exists shared_agents_select on public.shared_agents;
create policy shared_agents_select on public.shared_agents
  for select using (public.is_workspace_member(workspace_id));
drop policy if exists shared_agents_insert on public.shared_agents;
create policy shared_agents_insert on public.shared_agents
  for insert with check (public.is_workspace_member(workspace_id));
drop policy if exists shared_agents_update on public.shared_agents;
create policy shared_agents_update on public.shared_agents
  for update using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
drop policy if exists shared_agents_delete on public.shared_agents;
create policy shared_agents_delete on public.shared_agents
  for delete using (public.is_workspace_member(workspace_id));

drop policy if exists resources_select on public.resources;
create policy resources_select on public.resources
  for select using (public.is_workspace_member(workspace_id));
drop policy if exists resources_insert on public.resources;
create policy resources_insert on public.resources
  for insert with check (public.is_workspace_member(workspace_id));
drop policy if exists resources_update on public.resources;
create policy resources_update on public.resources
  for update using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
drop policy if exists resources_delete on public.resources;
create policy resources_delete on public.resources
  for delete using (public.is_workspace_member(workspace_id));
