interface Claim { sessionId: string; expiresAt: number; active: boolean; claimed: boolean }

export function createPendingClaims(now: () => number) {
  const claims = new Map<string, Claim>();
  const remove = (state: string) => {
    const claim = claims.get(state);
    if (claim) claim.active = false;
    claims.delete(state);
  };
  const cancelSession = (sessionId: string) => {
    for (const [state, claim] of claims) if (claim.sessionId === sessionId) remove(state);
  };
  return {
    prune() {
      for (const [state, claim] of claims) if (claim.expiresAt <= now()) remove(state);
    },
    replace(sessionId: string, state: string, expiresAt: number) {
      cancelSession(sessionId);
      claims.set(state, { sessionId, expiresAt, active: true, claimed: false });
    },
    get: (state: string) => claims.get(state),
    delete: remove,
    cancelSession,
  };
}
export type PendingClaims = ReturnType<typeof createPendingClaims>;
