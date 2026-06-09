-- ════════════════════════════════════════════════════════════════════════════
-- Per-owner kanban attribution.
--
-- The tasks table (0003) had no machine_id column, but pushState stamps every
-- synced row with machine_id — so the tasks upsert silently failed (PGRST204:
-- unknown column) and tasks never synced. This adds:
--   machine_id  — the origin machine (who owns this task's board)
--   owner_label — a friendly owner name (the owner's signed-in email), for the
--                 board picker in the UI
-- plus an index for the "view a teammate's board" query (by workspace + machine).
--
-- Conflict key is still (workspace_id, task_id); RLS is unchanged (membership-
-- scoped). Each person's LOCAL board (tasks.json) stays their own — the client no
-- longer merges teammates' tasks into it; teammate boards are viewed on demand
-- from this table, filtered by machine_id.
-- ════════════════════════════════════════════════════════════════════════════

alter table public.tasks
  add column if not exists machine_id  text,
  add column if not exists owner_label text;

create index if not exists idx_tasks_ws_machine on public.tasks (workspace_id, machine_id);
