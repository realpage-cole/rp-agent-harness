import { useEffect, useState } from 'react';

/** A teammate hive you can switch the dashboard to view (read-only). */
export interface HiveOwner {
  machineId: string;
  ownerLabel: string | null;
}

/** A teammate's agent, read-only (slim mirror of the synced row). */
export interface TeammateAgent {
  id: string;
  name: string;
  status: string;
  isGod: boolean;
}

/**
 * Polls the list of teammate hives you can switch to (everyone in the workspace
 * but you), via window.cth.syncListHiveOwners(). Empty when sync is off / signed
 * out. Drives the unified view selector.
 */
export function useHiveOwners(pollMs = 20000): HiveOwner[] {
  const [owners, setOwners] = useState<HiveOwner[]>([]);
  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const list = await window.cth.syncListHiveOwners();
        if (!cancelled) setOwners(Array.isArray(list) ? list : []);
      } catch { /* keep the last list */ }
    };
    void load();
    const handle = setInterval(() => { void load(); }, pollMs);
    return () => { cancelled = true; clearInterval(handle); };
  }, [pollMs]);
  return owners;
}

/**
 * Polls a teammate's roster (read-only) via window.cth.syncTeammateAgents(id) when
 * `machineId` is set; idle (empty) when null (your own roster comes from the store).
 */
export function useTeammateAgents(
  machineId: string | null,
  pollMs = 5000
): { agents: TeammateAgent[]; loaded: boolean } {
  const [agents, setAgents] = useState<TeammateAgent[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!machineId) { setAgents([]); setLoaded(true); return; }
    let cancelled = false;
    setLoaded(false);
    const poll = async (): Promise<void> => {
      try {
        const list = await window.cth.syncTeammateAgents(machineId);
        if (cancelled) return;
        setAgents(Array.isArray(list) ? list : []);
        setLoaded(true);
      } catch {
        if (!cancelled) setLoaded(true);
      }
    };
    void poll();
    const handle = setInterval(() => { void poll(); }, pollMs);
    return () => { cancelled = true; clearInterval(handle); };
  }, [machineId, pollMs]);
  return { agents, loaded };
}
