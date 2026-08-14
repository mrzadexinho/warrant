import { MAX_TARGET_LENGTH } from '@idriszade/warrant-core';
import type { ActionRequest, Verdict } from '@idriszade/warrant-core';
import type { PolicyDoc } from './schema.js';
import { globToRegExp } from './match.js';

export function evaluate(
  request: ActionRequest,
  policy: { doc: PolicyDoc; hash: string },
): Verdict {
  const { doc } = policy;
  const base = { policyVersion: doc.version, policyHash: policy.hash };

  // FAIL-CLOSED guard: malformed request fields → immediate deny, never throw.
  if (typeof request.action.target !== 'string') {
    return { ...base, path: 'deny', ruleId: 'malformed-request',
      reason: 'action.target is not a string' };
  }
  // An oversized target is malformed, not merely unmatched: the glob matcher's cost scales
  // with target length, so evaluating a multi-megabyte target is a resource-exhaustion
  // vector, and no legitimate addressee approaches this bound. Denying here, not skipping
  // the match, keeps the protected-audience rule impossible to evade by oversizing.
  if (request.action.target.length > MAX_TARGET_LENGTH) {
    return { ...base, path: 'deny', ruleId: 'malformed-request',
      reason: `action.target exceeds ${MAX_TARGET_LENGTH} chars` };
  }
  if (request.context === null || typeof request.context !== 'object') {
    return { ...base, path: 'deny', ruleId: 'malformed-request',
      reason: 'context is null or not an object' };
  }

  // 1) protected audiences: case-insensitive glob match vs action.target (LOCKED: first).
  // Email domains are case-insensitive; lowercasing both sides prevents bypass via uppercase.
  const targetLower = request.action.target.toLowerCase();
  for (const pattern of doc.protectedAudiences) {
    if (globToRegExp(pattern.toLowerCase()).test(targetLower)) {
      return {
        ...base, path: 'deny', ruleId: 'protected-audience',
        reason: `target matches protected audience: ${pattern}`,
      };
    }
  }

  // 2) daily caps (LOCKED: second).
  // Missing sentTodayByKind means zero sent: legitimate first send, not malformed.
  const sentTodayRaw = request.context['sentTodayByKind'];
  const sentToday: Record<string, number> =
    (sentTodayRaw !== null && typeof sentTodayRaw === 'object' && !Array.isArray(sentTodayRaw))
      ? (sentTodayRaw as Record<string, number>)
      : {};
  const kindCap = doc.caps.perPrincipalDaily[request.action.kind];
  if (kindCap !== undefined) {
    // A present-but-non-numeric count is malformed, never a bypass: NaN compares false
    // against every cap, so coercing here would silently disable the limit.
    const sentRaw = sentToday[request.action.kind];
    if (sentRaw !== undefined && (typeof sentRaw !== 'number' || Number.isNaN(sentRaw))) {
      return { ...base, path: 'deny', ruleId: 'malformed-request',
        reason: `sentTodayByKind['${request.action.kind}'] is not a number` };
    }
    const sent = sentRaw ?? 0;
    if (sent >= kindCap) {
      return {
        ...base, path: 'deny', ruleId: 'daily-cap',
        reason: `cap ${kindCap} reached for ${request.action.kind} (sent: ${sent})`,
      };
    }
  }

  // 3) first matching stakes rule (LOCKED: third)
  const audience = request.context['audience'] as string | undefined;
  for (const rule of doc.stakes) {
    if (
      rule.match.actionKind === request.action.kind &&
      (rule.match.audience === undefined || rule.match.audience === audience)
    ) {
      return {
        ...base, path: rule.path, ruleId: rule.id,
        reason: `matched stakes rule: ${rule.id}`,
      };
    }
  }

  // 4) default deny (LOCKED: final fallback)
  return {
    ...base, path: 'deny', ruleId: 'default-deny',
    reason: 'no stakes rule matched; defaults.path = deny',
  };
}
