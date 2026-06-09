-- ════════════════════════════════════════════════════════════════════════════
-- Shared semantic memory (Ollama embeddings + pgvector).
--
-- Replaces the per-machine, HuggingFace-bound MemPalace palace with ONE shared,
-- workspace-scoped semantic index. Each owner embeds their OWN agents' memory.md
-- LOCALLY via Ollama (nomic-embed-text, 768-dim — HuggingFace is blocked by the
-- RealPage network policy) and pushes the chunk vectors here. Search embeds the
-- query locally too, then runs cosine top-K across the whole team's memory — so
-- the searchable memory layer itself is shared across teammates, sessions, and
-- projects, not rebuilt N times locally.
--
-- The SOURCE OF TRUTH stays the markdown: agent_memory.body (synced separately).
-- These chunks are a derived, rebuildable index — owner+machine scoped so each
-- person owns their rows (mirrors agents/tasks per-machine keying).
-- ════════════════════════════════════════════════════════════════════════════

create extension if not exists vector with schema extensions;

create table if not exists public.memory_chunks (
  workspace_id text not null,
  machine_id   text not null,
  agent_id     text not null,
  -- stable per (agent, ordinal) so re-embeds upsert in place; we delete-then-insert
  -- an agent's chunks on each content change, so ordinal churn is bounded anyway.
  chunk_id     text not null,
  name         text,                          -- agent display name (cosmetic)
  owner_label  text,                          -- owner email, for attribution in the UI
  content      text not null,                 -- the chunk text (what search returns)
  content_hash text not null,                 -- sha1 of the SOURCE memory.md, gates re-embed
  embedding    extensions.vector(768) not null,
  updated_at   bigint not null,
  created_at   timestamptz not null default now(),
  primary key (workspace_id, machine_id, agent_id, chunk_id)
);

create index if not exists idx_memory_chunks_ws
  on public.memory_chunks (workspace_id);
create index if not exists idx_memory_chunks_ws_machine_agent
  on public.memory_chunks (workspace_id, machine_id, agent_id);
-- ANN index for cosine search. hnsw is the better default for read-heavy recall.
create index if not exists idx_memory_chunks_embedding
  on public.memory_chunks using hnsw (embedding extensions.vector_cosine_ops);

alter table public.memory_chunks enable row level security;

-- Membership-scoped, identical posture to agents/tasks/board. A member may read
-- the whole workspace's chunks (that IS the shared recall) and write rows (each
-- client only ever writes its own machine's, but RLS need only gate the workspace).
drop policy if exists memory_chunks_select on public.memory_chunks;
create policy memory_chunks_select on public.memory_chunks
  for select using (public.is_workspace_member(workspace_id));
drop policy if exists memory_chunks_insert on public.memory_chunks;
create policy memory_chunks_insert on public.memory_chunks
  for insert with check (public.is_workspace_member(workspace_id));
drop policy if exists memory_chunks_update on public.memory_chunks;
create policy memory_chunks_update on public.memory_chunks
  for update using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
drop policy if exists memory_chunks_delete on public.memory_chunks;
create policy memory_chunks_delete on public.memory_chunks
  for delete using (public.is_workspace_member(workspace_id));

-- Cosine top-K over a workspace's chunks. SECURITY INVOKER (default) so the
-- caller's RLS still applies — p_workspace is an extra explicit filter, not the
-- security boundary. p_query is the pgvector literal '[v1,v2,...]' (most reliable
-- to pass from supabase-js); cast to vector inside. p_agent scopes to one agent.
create or replace function public.match_memory_chunks(
  p_workspace text,
  p_query     text,
  p_k         int  default 8,
  p_agent     text default null
)
returns table (
  agent_id    text,
  machine_id  text,
  owner_label text,
  name        text,
  content     text,
  similarity  double precision
)
language sql
stable
set search_path = public, extensions
as $$
  select
    c.agent_id,
    c.machine_id,
    c.owner_label,
    c.name,
    c.content,
    1 - (c.embedding <=> p_query::extensions.vector) as similarity
  from public.memory_chunks c
  where c.workspace_id = p_workspace
    and (p_agent is null or c.agent_id = p_agent)
  order by c.embedding <=> p_query::extensions.vector
  limit greatest(1, least(coalesce(p_k, 8), 50))
$$;

grant execute on function public.match_memory_chunks(text, text, int, text) to authenticated;
