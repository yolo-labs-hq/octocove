/** Trusted scheduler ingress, after webhook signature verification. The envelope
 * is the queue body as received, not a remapped scheduler DTO. Workers Queues
 * callers implement send with queue.send(body, { contentType: 'text' }). */
export async function forwardEventEnvelope(
  bytes: string,
  queue: { send(body: string): Promise<unknown> },
): Promise<void> {
  const envelope = JSON.parse(bytes);
  if (envelope?.schemaVersion !== 1 || typeof envelope.id !== 'string' ||
      typeof envelope.type !== 'string' || typeof envelope.occurredAt !== 'string' ||
      !('projectId' in envelope) || !('taskId' in envelope) || !envelope.data) {
    throw new Error('invalid-event-envelope');
  }
  await queue.send(bytes); // Resolve only after durable acceptance; retry on failure.
}
