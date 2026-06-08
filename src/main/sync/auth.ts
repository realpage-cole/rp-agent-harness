/**
 * sync/auth.ts — Phase 4 auth helpers (Supabase Auth, email/password) + workspace
 * create/join. Pure-ish: every function takes the loosely-typed client + the
 * SyncStore (kv) and is deliberately free of any `electron` import, matching the
 * rest of sync/* so it can be unit-/smoke-tested as plain Node.
 *
 * SECURITY: the session (access/refresh tokens) lives ONLY here + in the store kv
 * under `K_AUTH_SESSION` (MAIN process). It NEVER crosses IPC — the renderer only
 * ever sees the tokenless `AuthState`. SyncManager owns calling these; IPC layers
 * (Wave 2) persist `syncWorkspaceId` via writeConfig — auth.ts only does DB rows.
 *
 * Best-effort throughout: nothing here ever throws into SyncManager — every
 * Supabase call is wrapped, failures become `{ ok:false, error }` (or a signed-out
 * AuthState), and tokens are NEVER logged.
 */
import { randomUUID } from 'node:crypto';
import {
  type SupabaseLike,
  type SyncStore,
  type AuthState,
  K_AUTH_SESSION
} from './types';
import { errMsg } from './io';

/** Result of a sign-in attempt. Tokenless by construction — callers surface only
 *  ok/error (+ identity) to the renderer; the session is persisted internally. */
export interface SignInResult {
  ok: boolean;
  userId?: string;
  email?: string;
  error?: string;
}

/** Result of a workspace create/join. Returns the workspace id on success so the
 *  caller can persist it as `syncWorkspaceId` via writeConfig. */
export interface WorkspaceResult {
  ok: boolean;
  workspaceId?: string;
  error?: string;
}

/** Options for ensureWorkspace: either create a new workspace (`create:true` +
 *  `name`) or join an existing one (`id`). */
export interface EnsureWorkspaceOpts {
  create?: boolean;
  name?: string;
  id?: string;
}

/** A signed-out AuthState (the safe default everywhere). */
const SIGNED_OUT: AuthState = { signedIn: false, userId: null, email: null };

/** The persisted session shape (MAIN-only — store kv `K_AUTH_SESSION`). The ONLY
 *  place these tokens live outside the in-memory supabase client. */
interface StoredSession {
  access_token: string;
  refresh_token: string;
}

/**
 * Sign in with email/password. On success, persist {access_token, refresh_token}
 * to store kv `K_AUTH_SESSION` (MAIN-only) and return {ok, userId, email}.
 *
 * Best-effort: a client throw / server error becomes `{ ok:false, error }`; the
 * session is persisted ONLY on a fully successful sign-in (user + session both
 * present). Tokens are never logged.
 */
export async function signIn(
  client: SupabaseLike,
  store: SyncStore,
  email: string,
  password: string
): Promise<SignInResult> {
  let data: {
    user: { id: string; email?: string } | null;
    session: { access_token: string; refresh_token: string } | null;
  } | null;
  let error: { message: string } | null;
  try {
    ({ data, error } = await client.auth.signInWithPassword({ email, password }));
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
  if (error) return { ok: false, error: error.message };

  const user = data?.user ?? null;
  const session = data?.session ?? null;
  if (!user || !session) return { ok: false, error: 'sign-in returned no session' };

  store.setKv(K_AUTH_SESSION, {
    access_token: session.access_token,
    refresh_token: session.refresh_token
  });

  return { ok: true, userId: user.id, email: user.email ?? email };
}

/**
 * Restore a persisted session: read kv `K_AUTH_SESSION`; if present, call
 * `client.auth.setSession(...)` so the client is authenticated (RLS sees
 * auth.uid()). Returns the resolved tokenless AuthState.
 *
 * Best-effort: no stored session (or a setSession failure) yields a signed-out
 * state — the user just signs in again. Tokens are never logged.
 */
export async function restoreSession(
  client: SupabaseLike,
  store: SyncStore
): Promise<AuthState> {
  const stored = store.getKv<StoredSession>(K_AUTH_SESSION);
  if (!stored || !stored.access_token || !stored.refresh_token) {
    return { ...SIGNED_OUT };
  }

  let data: { user: { id: string; email?: string } | null } | null;
  let error: { message: string } | null;
  try {
    ({ data, error } = await client.auth.setSession({
      access_token: stored.access_token,
      refresh_token: stored.refresh_token
    }));
  } catch {
    return { ...SIGNED_OUT };
  }
  if (error) return { ...SIGNED_OUT };

  const user = data?.user ?? null;
  if (!user) return { ...SIGNED_OUT };

  return { signedIn: true, userId: user.id, email: user.email ?? null };
}

/**
 * Sign out: `client.auth.signOut()` then delete the persisted session from kv
 * `K_AUTH_SESSION`. Best-effort: even if the server call throws, the local
 * session is still cleared so the user ends up signed out locally.
 */
export async function signOut(
  client: SupabaseLike,
  store: SyncStore
): Promise<void> {
  try {
    await client.auth.signOut();
  } catch {
    /* best-effort — clear the local session regardless. */
  }
  // Tombstone the session (the SyncStore only exposes getKv/setKv — no delete).
  // `setKv(key, undefined)` would bind `undefined` into SQLite and throw, so we
  // write `null`; restoreSession treats a null/incomplete session as signed-out.
  store.setKv(K_AUTH_SESSION, null);
}

/**
 * Create or join a workspace. When `create`, insert into `workspaces {id, name}`
 * (id generated client-side so we don't need RETURNING off the loose upsert
 * surface; `created_by` defaults to auth.uid() server-side), then insert a
 * `workspace_members {workspace_id:id}` row (user_id defaults to auth.uid()).
 * When joining (`id`), insert only the `workspace_members` row for self. Returns
 * the workspace id; the CALLER (SyncManager/IPC) persists it via writeConfig —
 * this function only writes the DB rows.
 *
 * Best-effort: a client throw / server error becomes `{ ok:false, error }`.
 * Requires a signed-in client (RLS rejects the inserts otherwise).
 */
export async function ensureWorkspace(
  client: SupabaseLike,
  store: SyncStore,
  opts: EnsureWorkspaceOpts
): Promise<WorkspaceResult> {
  void store; // reserved for parity with the other helpers; no kv needed here.

  if (opts.create) {
    const name = (opts.name ?? '').trim();
    if (!name) return { ok: false, error: 'workspace name required' };

    // Generate the id client-side (a uuid stored as text, matching the migration's
    // gen_random_uuid()::text default) so we can both insert the workspace_members
    // row and return the id without needing a RETURNING off the loose upsert API.
    const workspaceId = randomUUID();

    let error: { message: string } | null;
    try {
      ({ error } = await client
        .from('workspaces')
        .upsert([{ id: workspaceId, name }], { onConflict: 'id' }));
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
    if (error) return { ok: false, error: error.message };

    const joined = await joinMembership(client, workspaceId);
    if (joined.error) return { ok: false, error: joined.error };
    return { ok: true, workspaceId };
  }

  const id = (opts.id ?? '').trim();
  if (!id) return { ok: false, error: 'workspace id required' };

  const joined = await joinMembership(client, id);
  if (joined.error) return { ok: false, error: joined.error };
  return { ok: true, workspaceId: id };
}

/** Insert THIS user's membership row for `workspaceId`. `user_id` defaults to
 *  auth.uid() server-side, so we only send workspace_id. Upsert-on-conflict makes
 *  a re-join idempotent. Returns an error string on failure, null on success. */
async function joinMembership(
  client: SupabaseLike,
  workspaceId: string
): Promise<{ error: string | null }> {
  let error: { message: string } | null;
  try {
    ({ error } = await client
      .from('workspace_members')
      .upsert([{ workspace_id: workspaceId }], {
        onConflict: 'workspace_id,user_id',
        ignoreDuplicates: true
      }));
  } catch (e) {
    return { error: errMsg(e) };
  }
  return { error: error ? error.message : null };
}
