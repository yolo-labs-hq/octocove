export async function applyNextReleaseSchema(db: D1Database) {
    for (const [table, column] of [['repository_creations', 'seed'], ['submissions', 'work_attribution'], ['landing_receipts', 'work_attribution']]) {
        const columns = await db.prepare(`PRAGMA table_info(${table})`).all<{
            name: string;
        }>();
        if (!columns.results.some(row => row.name === column))
            throw new Error(`release schema missing ${table}.${column}`);
    }
    for (const table of ['landing_receipts', 'submissions', 'repository_creations'])
        await db.prepare(`ALTER TABLE ${table} ADD COLUMN future_metadata TEXT DEFAULT 'not-public'`).run();
}
