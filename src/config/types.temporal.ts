export type TemporalConfig = {
  /** Enable durable orchestration via Temporal.io. */
  enabled?: boolean;
  /** Temporal cluster address (e.g. 127.0.0.1:7233). */
  address?: string;
  /** Temporal namespace. Default: default. */
  namespace?: string;
  /** Task queue for OpenClaw workers. Default: openclaw-tasks. */
  taskQueue?: string;
  /**
   * Features to migrate to Temporal.
   */
  features?: {
    /** Migrate agent heartbeats to durable Temporal workflows. */
    heartbeats?: boolean;
    /** Migrate memory reflection to durable Temporal workflows. */
    reflection?: boolean;
  };
};
