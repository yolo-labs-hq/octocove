/** Trusted scheduler ingress, after webhook signature verification (and the
 * Octocove-Tenant-Id check). The envelope is the queue body as received, not a
 * remapped scheduler DTO: schema v2 only, naming its tenant. Consumers deduplicate by
 * (tenantId, id), never by sequence. Workers Queues callers implement send with
 * queue.send(body, { contentType: 'text' }). */
const TENANT_ID = /^org_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export async function forwardEventEnvelope(
  bytes: string,
  queue: { send(body: string): Promise<unknown> },
): Promise<void> {
  const envelope = JSON.parse(bytes);
  if (envelope?.schemaVersion !== 2 || typeof envelope.id !== 'string' ||
      typeof envelope.type !== 'string' || typeof envelope.occurredAt !== 'string' ||
      typeof envelope.tenantId !== 'string' || !TENANT_ID.test(envelope.tenantId) ||
      typeof envelope.sequence !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(envelope.sequence) ||
      !('projectId' in envelope) || !('taskId' in envelope) || !envelope.data) {
    throw new Error('invalid-event-envelope');
  }
  await queue.send(bytes); // Resolve only after durable acceptance; retry on failure.
}
