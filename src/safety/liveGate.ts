// Placeholder pass-through for paper mode. The real live-mode logic (Slack
// approval + daily cap + key separation) lands in step 6.
import type { Intent } from '../engine/strategy.js';

export interface GateResult {
  approved: boolean;
  status: 'submitted' | 'pending_approval' | 'rejected' | 'skipped';
  reason: string;
}

export async function gateLiveOrder(input: {
  runId: string;
  intent: Intent;
  mode: 'paper' | 'live';
}): Promise<GateResult> {
  if (input.mode === 'paper') {
    return { approved: true, status: 'submitted', reason: 'paper mode' };
  }
  return { approved: false, status: 'pending_approval', reason: 'live gate not yet implemented' };
}
