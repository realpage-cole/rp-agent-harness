-- ════════════════════════════════════════════════════════════════════════════
-- Per-machine roster + task keys.
--
-- The synced mirror keyed agents on (workspace_id, agent_id) and tasks on
-- (workspace_id, task_id) — but each teammate's hive is independent, so those
-- collide across machines. Most acutely: every orchestrator is agent_id='god', so
-- teammates' gods overwrote each other's row. Re-key both to include machine_id so
-- each person's hive is distinct and a teammate's roster/board can be viewed on
-- demand (the kanban + roster are per-owner; you view a teammate's via the toggle).
--
-- The BLACKBOARD stays SHARED by design (board PK remains workspace_id) — it's the
-- team's single coordination surface.
--
-- agents.owner_label: friendly owner name (signed-in email) for the board picker.
-- ════════════════════════════════════════════════════════════════════════════

alter table public.agents add column if not exists owner_label text;
alter table public.agents drop constraint if exists agents_pkey;
alter table public.agents add  constraint agents_pkey primary key (workspace_id, machine_id, agent_id);

update public.tasks set machine_id = coalesce(machine_id, 'unknown') where machine_id is null;
alter table public.tasks alter column machine_id set not null;
alter table public.tasks drop constraint if exists tasks_pkey;
alter table public.tasks add  constraint tasks_pkey primary key (workspace_id, machine_id, task_id);
