export const MEMORY_ROLLOVER_WARN_CHARS = 8_000;
export const MEMORY_ROLLOVER_START_CHARS = 10_000;
export const MEMORY_ROLLOVER_SNAPSHOT_MAX_CHARS = 4_000;

export type MemoryRolloverStatus = "none" | "recommended" | "required";

export interface MemoryRolloverAdvice {
  status: MemoryRolloverStatus;
  contentChars: number;
  warnAt: number;
  rolloverAt: number;
}

/**
 * Advisory policy only. append remains backwards compatible up to its existing
 * hard limit; callers can move the continuing state into a fresh entry before
 * the next append without rewriting or deleting the journal entry.
 */
export function memoryRolloverAdvice(contentChars: number): MemoryRolloverAdvice {
  return {
    status: contentChars >= MEMORY_ROLLOVER_START_CHARS
      ? "required"
      : contentChars >= MEMORY_ROLLOVER_WARN_CHARS
        ? "recommended"
        : "none",
    contentChars,
    warnAt: MEMORY_ROLLOVER_WARN_CHARS,
    rolloverAt: MEMORY_ROLLOVER_START_CHARS,
  };
}
