import { useHiveTasks, type DashboardTask } from './useHiveTasks';

export interface UseHumanQueue {
  /** How many blocked tasks have an open question parked for the human. */
  count: number;
  /** The blocked tasks awaiting a human answer (for an optional preview list). */
  tasks: DashboardTask[];
}

/**
 * The "needs you" count: blocked tasks the orchestrator has parked for the
 * human (a humanQA entry with a question and no answer yet). This is the data
 * that drove the old office "ASK ME" board's note count. Shares the same
 * `hiveTasks` poll as {@link useHiveTasks}.
 */
export function useHumanQueue(pollMs = 5000): UseHumanQueue {
  const { tasks } = useHiveTasks(pollMs);
  const waiting = tasks.filter((t) => t.needsHuman);
  return { count: waiting.length, tasks: waiting };
}
