-- ════════════════════════════════════════════════════════════════════════════
-- Notepad board redesign — attributed entries for the TWO Notepad boards:
--
--   public.board_entries — one row per posted entry on EITHER board:
--     • board='agent'  — forward-looking project/feature ideas the orchestrator's
--       harness-driven THOUGHTS service appends (author_kind='agent',
--       agent_id='orchestrator'). Humans may delete these but never add to them.
--     • board='human'   — short notes a teammate jots in the Human board's add box
--       (author_kind='human', author_label=signed-in email, author_machine=machine).
--
-- Both boards are workspace-scoped + read newest-first, and are membership-gated
-- via the existing public.is_workspace_member(ws) helper — identical posture to
-- member_notes / shared_agents / resources (migration 20260610000001).
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists public.board_entries (
  workspace_id   text        not null,        -- workspaces.id (membership-scoped)
  entry_id       text        not null,        -- random uuid; the entry id
  board          text        not null check (board in ('agent', 'human')),
  author_kind    text        not null check (author_kind in ('agent', 'human')),
  author_label   text,                        -- author email, for attribution
  author_machine text,                        -- authoring machine id (drives isMine)
  agent_id       text,                        -- agent id for an agent-authored entry
  body           text        not null,
  updated_at     bigint      not null,        -- ms epoch
  created_at     timestamptz not null default now(),
  primary key (workspace_id, entry_id)
);
-- Newest-first reads are scoped to (workspace, board), so order by created_at.
create index if not exists idx_board_entries_ws_board_created
  on public.board_entries (workspace_id, board, created_at);

-- ─── RLS — membership-scoped, identical posture to member_notes/resources ─────
alter table public.board_entries enable row level security;

drop policy if exists board_entries_select on public.board_entries;
create policy board_entries_select on public.board_entries
  for select using (public.is_workspace_member(workspace_id));
drop policy if exists board_entries_insert on public.board_entries;
create policy board_entries_insert on public.board_entries
  for insert with check (public.is_workspace_member(workspace_id));
drop policy if exists board_entries_update on public.board_entries;
create policy board_entries_update on public.board_entries
  for update using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
drop policy if exists board_entries_delete on public.board_entries;
create policy board_entries_delete on public.board_entries
  for delete using (public.is_workspace_member(workspace_id));
