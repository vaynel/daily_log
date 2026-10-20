export interface ProbeContext {
  support?: 'verified' | 'unknown' | 'unsupported';
  auth?: 'valid' | 'unknown' | 'expired';
  quota?: 'available' | 'unknown' | 'exhausted';
}
export interface ProbeInput { kind: string; text: string }
export type ProbeReply = { ok: true } | { ok: false; status: number; code?: string };
export type ProbeState = 'SUCCEEDED' | 'WAIT_SUPPORT' | 'WAIT_AUTH' | 'WAIT_LIMIT'
  | 'UNSUPPORTED_INPUT' | 'WAIT_RETRY' | 'WAIT_REVIEW' | 'WAIT_RECONCILIATION';
export interface ProbeResult { state: ProbeState; attempts: number }

/**
 * Offline SPIKE boundary, not wired into the worker or HTTP API.
 * Context must eventually come from verified server-side support/auth/quota
 * evidence, never a user request. No API-key fallback or automatic retry exists.
 * The adapter must return ok only after response completion, not stream opening.
 */
export async function runProRequest(
  input: ProbeInput,
  context: ProbeContext,
  subscriptionTransport: (input: ProbeInput) => Promise<ProbeReply>,
): Promise<ProbeResult> {
  if (context.support !== 'verified') return { state: 'WAIT_SUPPORT', attempts: 0 };
  if (context.auth !== 'valid') return { state: 'WAIT_AUTH', attempts: 0 };
  if (context.quota !== 'available') return { state: 'WAIT_LIMIT', attempts: 0 };
  // Images/files may be supported upstream, but have not been validated here.
  if (input.kind !== 'text' || !input.text.trim()) {
    return { state: 'UNSUPPORTED_INPUT', attempts: 0 };
  }

  try {
    const reply = await subscriptionTransport(input);
    if (reply.ok) return { state: 'SUCCEEDED', attempts: 1 };
    let state: ProbeState = 'WAIT_REVIEW';
    if (reply.status === 429) state = 'WAIT_LIMIT';
    else if (reply.status === 401) state = 'WAIT_AUTH';
    else if (reply.status === 403) state = 'WAIT_SUPPORT';
    else if (reply.code === 'subscription_sharing_unsupported_capability') state = 'UNSUPPORTED_INPUT';
    else if (reply.status === 503) state = 'WAIT_RETRY';
    return { state, attempts: 1 };
  } catch {
    // A lost response may already have incurred work: reconcile before retry.
    // Never return raw errors, credentials, response bodies or personal content.
    return { state: 'WAIT_RECONCILIATION', attempts: 1 };
  }
}
