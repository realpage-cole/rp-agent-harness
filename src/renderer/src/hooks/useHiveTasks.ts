import { useEffect, useRef, useState } from 'react';

/** A single task as it appears on the kanban — a slim, defensively-parsed view
 *  of the hive ledger (hive/tasks.json). Mirrors the fields the dashboard needs;
 *  the full record lives behind the task-detail overlay. */
export interface DashboardTask {
  id: string;
  title: string;
  status: 'todo' | 'doing' | 'blocked' | 'done';
  assignee?: string;
  /** True when this blocked task has an open question parked for the human
   *  (a humanQA entry with a `q` and no `a`). */
  needsHuman: boolean;
}

export type TaskStatus = DashboardTask['status'];

/** Tasks bucketed by kanban column, in fixed column order. */
export interface GroupedTasks {
  todo: DashboardTask[];
  doing: DashboardTask[];
  blocked: DashboardTask[];
  done: DashboardTask[];
}

const EMPTY_GROUPS: GroupedTasks = { todo: [], doing: [], blocked: [], done: [] };

const VALID_STATUS = new Set<TaskStatus>(['todo', 'doing', 'blocked', 'done']);

interface RawTask {
  id?: string;
  title?: string;
  status?: string;
  assignee?: string;
  humanQA?: Array<{ q?: string; a?: string }>;
}

function parseTasks(raw: unknown): DashboardTask[] {
  const arr = (raw && typeof raw === 'object' && Array.isArray((raw as { tasks?: unknown }).tasks))
    ? (raw as { tasks: RawTask[] }).tasks
    : [];
  return arr.map((t, i) => {
    const status = (typeof t?.status === 'string' && VALID_STATUS.has(t.status as TaskStatus))
      ? (t.status as TaskStatus)
      : 'todo';
    const needsHuman = status === 'blocked'
      && Array.isArray(t?.humanQA)
      && t.humanQA.some((e) => e && typeof e.q === 'string' && !e.a);
    return {
      id: typeof t?.id === 'string' && t.id ? t.id : `idx-${i}`,
      title: typeof t?.title === 'string' && t.title ? t.title : 'Untitled task',
      status,
      assignee: typeof t?.assignee === 'string' && t.assignee ? t.assignee : undefined,
      needsHuman
    };
  });
}

function group(tasks: DashboardTask[]): GroupedTasks {
  const g: GroupedTasks = { todo: [], doing: [], blocked: [], done: [] };
  for (const t of tasks) g[t.status].push(t);
  return g;
}

export interface UseHiveTasks {
  tasks: DashboardTask[];
  grouped: GroupedTasks;
  /** False until the first poll resolves — lets callers show a loader. */
  loaded: boolean;
}

/**
 * Polls `window.cth.hiveTasks()` on a fixed cadence (default 5s, matching the
 * old office task-board poll) and exposes the ledger both flat and grouped by
 * kanban column. Pure data — no rendering, no scene coupling.
 */
export function useHiveTasks(pollMs = 5000): UseHiveTasks {
  const [tasks, setTasks] = useState<DashboardTask[]>([]);
  const [loaded, setLoaded] = useState(false);
  const groupedRef = useRef<GroupedTasks>(EMPTY_GROUPS);

  useEffect(() => {
    let cancelled = false;
    const poll = async (): Promise<void> => {
      try {
        const raw = await window.cth.hiveTasks();
        if (cancelled) return;
        setTasks(parseTasks(raw));
        setLoaded(true);
      } catch {
        // keep the last good snapshot; the next tick retries
        if (!cancelled) setLoaded(true);
      }
    };
    void poll();
    const handle = setInterval(() => { void poll(); }, pollMs);
    return () => { cancelled = true; clearInterval(handle); };
  }, [pollMs]);

  groupedRef.current = group(tasks);
  return { tasks, grouped: groupedRef.current, loaded };
}
