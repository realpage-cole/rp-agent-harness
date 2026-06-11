import { useEffect, useRef, useState } from 'react';
import { useStore } from '@/store/store';
import { teamIdOf } from '@/ipc/teams';

/** The act a routed hive message carried — mirrors HiveRouteEvent.act. */
export type MessageAct =
  | 'request' | 'inform' | 'propose' | 'query' | 'agree' | 'refuse' | 'done';

/** One routed message, captured for the activity feed. */
export interface FeedMessage {
  id: string;
  from: string;
  /** Resolved recipient ids ('human' for an escalation parked for the human). */
  targets: string[];
  act: MessageAct;
  subject: string;
  /** Set when the message was aimed at the human (cosmetic — no approval queue). */
  needsHuman: boolean;
  /** epoch ms the renderer observed the message. */
  ts: number;
}

/** Keep the feed bounded so a chatty session can't grow it without limit. */
const DEFAULT_CAP = 50;

let seq = 0;
function nextLocalId(): string {
  seq += 1;
  return `msg-${Date.now()}-${seq}`;
}

/**
 * Subscribes to `window.cth.onHiveMessage` and keeps a rolling, newest-first
 * feed of routed messages (capped at `cap`). This is the data that drove the
 * office's flying envelopes. Unsubscribes on unmount; degrades gracefully when
 * the preload bridge lacks `onHiveMessage` (older session) to an empty feed.
 */
export function useHiveMessages(cap = DEFAULT_CAP): FeedMessage[] {
  const [messages, setMessages] = useState<FeedMessage[]>([]);
  const capRef = useRef(cap);
  capRef.current = cap;
  // FE-2: the activity feed shows the in-view team; reset + filter on switch.
  const activeTeamId = useStore((s) => s.activeTeamId);

  useEffect(() => {
    setMessages([]);
    const sub = window.cth.onHiveMessage;
    if (!sub) return; // onHiveMessage unavailable this session — empty feed
    const off = sub((e) => {
      if (teamIdOf(e) !== activeTeamId) return; // another team's message
      const entry: FeedMessage = {
        id: e.id || nextLocalId(),
        from: e.from,
        targets: Array.isArray(e.targets) ? e.targets : [],
        act: e.act,
        subject: e.subject ?? '',
        needsHuman: !!e.needsHuman,
        ts: Date.now()
      };
      setMessages((prev) => [entry, ...prev].slice(0, capRef.current));
    });
    return () => { off(); };
  }, [activeTeamId]);

  return messages;
}
