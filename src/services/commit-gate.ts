/** A form owns this gate for its lifetime. Only a failed commit can be retried. */
export function createCommitGate() {
  let phase: 'idle' | 'saving' | 'committed' = 'idle';
  return {
    phase: () => phase,
    async run<T>(commit: () => Promise<T>, afterCommit?: () => Promise<void>): Promise<{ value: T } | null> {
      if (phase !== 'idle') return null;
      phase = 'saving';
      try {
        const value = await commit();
        phase = 'committed';
        if (afterCommit) void Promise.resolve().then(afterCommit).catch(() => undefined);
        return { value };
      }
      finally { if (phase === 'saving') phase = 'idle'; }
    },
  };
}
