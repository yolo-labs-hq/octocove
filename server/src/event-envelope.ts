import type { AuditRow } from './audit';
export const eventTelemetryTypes = ['webhook.attempt_started', 'webhook.attempt_recorded', 'webhook.deliveries_inspected'] as const;
export function eventEnvelope(row: AuditRow) {
    return {
        id: `evt_${row.id}`, type: row.type, schemaVersion: 1 as const,
        projectId: row.projectId, taskId: row.taskId, occurredAt: row.at,
        data: row,
    };
}
