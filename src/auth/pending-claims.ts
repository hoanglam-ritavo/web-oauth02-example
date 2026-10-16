interface Claim {
  sessionId: string;
  expiresAt: number;
}

// Each app owns its claims. Operations stay synchronous so concurrent callbacks
// cannot both claim an attempt before session persistence completes.
export function createPendingClaims(now: () => number) {
  const claims = new Map<string, Claim>();
  return {
    prune() {
      for (const [state, claim] of claims)
        if (claim.expiresAt <= now()) claims.delete(state);
    },
    replace(sessionId: string, state: string, expiresAt: number) {
      // Invalidate overlapping login attempts for the same browser session.
      for (const [previousState, claim] of claims)
        if (claim.sessionId === sessionId) claims.delete(previousState);
      claims.set(state, { sessionId, expiresAt });
    },
    get(state: string): Claim | undefined {
      return claims.get(state);
    },
    delete(state: string) {
      claims.delete(state);
    },
  };
}

export type PendingClaims = ReturnType<typeof createPendingClaims>;
