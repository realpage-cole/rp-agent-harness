import { useEffect } from 'react';
import { useStore } from '@/store/store';
import { useHiveOwners } from '@/hooks/useHiveView';

/**
 * The unified hive-view selector. ONE shared selection (store `viewedOwner`)
 * switches the whole dashboard — roster + kanban — between your own hive and a
 * teammate's (read-only), so all panels change together. Empty list (sync off /
 * solo) just shows "My hive".
 */
export function HiveViewSelector() {
  const owners = useHiveOwners();
  const viewedOwner = useStore((s) => s.viewedOwner);
  const setViewedOwner = useStore((s) => s.setViewedOwner);

  // If the viewed teammate drops out of the (non-empty) list, fall back to mine.
  useEffect(() => {
    if (viewedOwner && owners.length > 0 && !owners.some((o) => o.machineId === viewedOwner.machineId)) {
      setViewedOwner(null);
    }
  }, [owners, viewedOwner, setViewedOwner]);

  const labelFor = (machineId: string, ownerLabel: string | null): string =>
    ownerLabel || `teammate ${machineId.slice(0, 6)}`;

  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--cth-text-body-sm)', color: 'var(--cth-ink-500)' }}>
      Viewing
      <select
        value={viewedOwner?.machineId ?? 'me'}
        onChange={(e) => {
          const v = e.target.value;
          if (v === 'me') { setViewedOwner(null); return; }
          const o = owners.find((x) => x.machineId === v);
          setViewedOwner({ machineId: v, ownerLabel: o?.ownerLabel ?? null });
        }}
        style={{
          fontSize: 'var(--cth-text-body-sm)', color: 'var(--cth-ink-900)',
          background: 'var(--cth-cream-100)', border: '1px solid var(--cth-ink-100)',
          borderRadius: 4, padding: '2px 6px', maxWidth: 220
        }}
      >
        <option value="me">My hive</option>
        {owners.map((o) => (
          <option key={o.machineId} value={o.machineId}>{labelFor(o.machineId, o.ownerLabel)}</option>
        ))}
      </select>
      {viewedOwner && <span style={{ color: 'var(--cth-ink-300)' }}>read-only</span>}
    </label>
  );
}
