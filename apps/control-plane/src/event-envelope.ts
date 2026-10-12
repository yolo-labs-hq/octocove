import type { AuditRow } from './audit';

/** Delivery bookkeeping stays in audit/log reads, never in the domain stream. */
export const eventTelemetryTypes = ['webhook.attempt_started', 'webhook.attempt_recorded', 'webhook.deliveries_inspected'] as const;

/** The v1 wire projection is identical for webhook delivery and cursor replay. */
export function eventEnvelope(row: AuditRow) {
  return {
    id: `evt_${row.id}`, type: row.type, schemaVersion: 1 as const,
    projectId: row.projectId, taskId: row.taskId, occurredAt: row.at,
    data: row,
  };
}
