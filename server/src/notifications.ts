export const notificationKinds = ['review-requested', 'approval-invalidated', 'landed', 'candidate-blocked',
    'claim-ended', 'repository-needs-operator', 'member-added'] as const;
export type NotificationKind = typeof notificationKinds[number];
export const NOTIFICATION_CAPACITY = { chunk: 100, chunks: 4, sweep: 500, retentionDays: 90 } as const;
const RETENTION_MS = NOTIFICATION_CAPACITY.retentionDays * 86400000;
export function notificationKind(type: string, refs: Record<string, unknown>): NotificationKind | null {
    switch (type) {
        case 'candidate.computed': return refs.entityType === 'candidate' && refs.toStatus === 'active' ? 'review-requested' : null;
        case 'approval.invalidated': return refs.entityType === 'approval' ? 'approval-invalidated' : null;
        case 'task.landed': return refs.entityType === 'task' && refs.toStatus === 'landed' && !refs.followup ? 'landed' : null;
        case 'candidate.blocked': return refs.entityType === 'candidate' ? 'candidate-blocked' : null;
        case 'claim.released':
        case 'claim.revoked': return refs.entityType === 'claim' ? 'claim-ended' : null;
        case 'repository.creation_needs_operator': return 'repository-needs-operator';
        case 'member.added': return 'member-added';
        default: return null;
    }
}
const MEMBER = "m.issuer||'|'||m.sub";
const HOLDS = (verb: string) => `EXISTS (SELECT 1 FROM json_each(m.verbs) WHERE value='${verb}')`;
const TASK_CREATOR = `${MEMBER} IN (SELECT created_by FROM tasks WHERE id=a.task_id)`;
const RECIPIENTS: Record<NotificationKind, string> = {
    'review-requested': `${HOLDS('candidates:approve')} AND NOT EXISTS (SELECT 1 FROM candidates k
    JOIN submissions s ON s.id=k.submission_id JOIN claims c ON c.id=s.claim_id
    WHERE k.id=json_extract(a.refs,'$.candidateId') AND ${MEMBER} IN (CASE WHEN c.actor_type='human' THEN c.actor_id END, c.authorized_by))`,
    'approval-invalidated': `${MEMBER} IN (SELECT approved_by FROM approvals WHERE id=json_extract(a.refs,'$.approvalId'))`,
    'landed': `(${TASK_CREATOR} OR ${MEMBER} IN (SELECT approved_by FROM approvals WHERE id=json_extract(a.refs,'$.approvalId')))`,
    'candidate-blocked': TASK_CREATOR,
    'claim-ended': TASK_CREATOR,
    'repository-needs-operator': `(${HOLDS('project:admin')} OR ${MEMBER} IN (SELECT principal FROM repository_creations WHERE id=json_extract(a.refs,'$.intentId')))`,
    'member-added': `${MEMBER}=json_extract(a.refs,'$.principalId')`,
};
const AS_OF_EVENT = `NOT EXISTS (SELECT 1 FROM audit_log j WHERE j.project_id=a.project_id AND j.id>a.id
    AND j.type='member.added' AND json_extract(j.refs,'$.principalId')=${MEMBER})`;
const insertFor = (kind: NotificationKind) => `INSERT INTO notifications(recipient_issuer,recipient_sub,kind,project_id,task_id,event_id,created_at)
  SELECT m.issuer, m.sub, ?2, a.project_id, a.task_id, a.id, a.at
  FROM audit_log a JOIN auth_memberships m ON m.project_id=a.project_id
  WHERE (SELECT cursor FROM notification_projector WHERE id=1)=CAST(?4 AS INTEGER)
    AND a.id=CAST(?1 AS INTEGER) AND a.at>=?3 AND NOT (a.actor_type='human' AND a.actor_id=${MEMBER})
    AND ${AS_OF_EVENT} AND ${RECIPIENTS[kind]}
  ORDER BY m.issuer, m.sub
  ON CONFLICT DO NOTHING`;
export async function projectNotifications(db: D1Database, now = Date.now()) {
    const cutoff = new Date(now - RETENTION_MS).toISOString();
    let projected = 0;
    for (let i = 0; i < NOTIFICATION_CAPACITY.chunks; i++) {
        const { cursor } = (await db.prepare('SELECT CAST(cursor AS TEXT) AS cursor FROM notification_projector WHERE id=1').first<{
            cursor: string;
        }>())!;
        const rows = (await db.prepare(`SELECT CAST(id AS TEXT) AS id, type, refs FROM audit_log
      WHERE id>CAST(? AS INTEGER) ORDER BY audit_log.id LIMIT ?`).bind(cursor, NOTIFICATION_CAPACITY.chunk).all<{
            id: string;
            type: string;
            refs: string;
        }>()).results;
        if (!rows.length)
            break;
        const end = rows.at(-1)!.id, marker = `-${end}`;
        const statements: D1PreparedStatement[] = [
            db.prepare('UPDATE notification_projector SET cursor=CAST(?2 AS INTEGER) WHERE id=1 AND cursor=CAST(?1 AS INTEGER)').bind(cursor, marker),
        ];
        for (const row of rows) {
            const kind = notificationKind(row.type, JSON.parse(row.refs));
            if (kind)
                statements.push(db.prepare(insertFor(kind)).bind(row.id, kind, cutoff, marker));
        }
        statements.push(db.prepare('UPDATE notification_projector SET cursor=CAST(?2 AS INTEGER) WHERE id=1 AND cursor=CAST(?1 AS INTEGER)')
            .bind(marker, end));
        await db.batch(statements);
        projected += rows.length;
        if (rows.length < NOTIFICATION_CAPACITY.chunk)
            break;
    }
    const swept = await sweepNotifications(db, now);
    return { projected, swept };
}
export async function sweepNotifications(db: D1Database, now = Date.now()) {
    const result = await db.prepare(`DELETE FROM notifications WHERE id IN
    (SELECT id FROM notifications WHERE created_at<? ORDER BY created_at LIMIT ?)`)
        .bind(new Date(now - RETENTION_MS).toISOString(), NOTIFICATION_CAPACITY.sweep).run();
    return result.meta.changes ?? 0;
}
