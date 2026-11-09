import { createHash, randomUUID } from "node:crypto";

/** Metadata only, stored as Pi custom entries (never model context).
 * Full prompts/results already live in the normal parent and worker sessions.
 */
export function createDelegateAudit(
  append: (type: string, data: Record<string, unknown>) => void,
  configuration: { description: string; workerInstructions: string },
) {
  const guidanceId = createHash("sha256").update(JSON.stringify(configuration)).digest("hex").slice(0, 16);
  let configured = false;
  let warned = false;
  const write = (data: Record<string, unknown>) => {
    try {
      append("delegate-audit", { schemaVersion: 1, implementation: "v2-context-audit-1",
        eventId: randomUUID(), guidanceId, ...data });
    } catch {
      // Audit failure must not turn a completed edit into a reported execution failure.
      if (!warned) console.warn("Delegate audit could not be saved; this session's audit coverage may be incomplete.");
      warned = true;
    }
  };
  return {
    guidanceId,
    record(data: Record<string, unknown>) {
      if (!configured) {
        write({ kind: "configuration", ...configuration });
        configured = true;
      }
      write(data);
    },
  };
}
