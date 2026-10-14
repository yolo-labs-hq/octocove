export function sanitizedFailure(error: unknown) {
    const value = error && typeof error === 'object' ? error as {
        code?: unknown;
        name?: unknown;
        message?: unknown;
        dependency?: unknown;
        telemetryCause?: unknown;
    } : {};
    if ((value.telemetryCause === 'database-error' && value.dependency === 'D1') ||
        (value.telemetryCause === 'queue-error' && value.dependency === 'Queue') ||
        (value.telemetryCause === 'provider-unavailable' && ['provider', 'artifacts'].includes(String(value.dependency))))
        return { cause: value.telemetryCause, dependency: value.dependency as string };
    if (value.dependency === 'artifacts')
        return { cause: 'provider-unavailable', dependency: 'artifacts' };
    const code = typeof value.code === 'string' ? value.code : '';
    const name = typeof value.name === 'string' ? value.name : '';
    const message = typeof value.message === 'string' ? value.message : '';
    if (name === 'SyntaxError')
        return { cause: 'invalid-json', dependency: 'request' };
    if (code === 'broker-provider-unavailable' || /provider|artifact/i.test(name))
        return { cause: 'provider-unavailable', dependency: 'provider' };
    if (code === 'D1_ERROR' || /\bD1_ERROR\b|\bD1Database\b/i.test(message) || /^D1/i.test(name))
        return { cause: 'database-error', dependency: 'D1' };
    if (/queue/i.test(name) || /\bqueue\b/i.test(message))
        return { cause: 'queue-error', dependency: 'Queue' };
    if (code === 'temporarily-unavailable')
        return { cause: 'temporarily-unavailable', dependency: 'unknown' };
    return { cause: 'unclassified-error', dependency: 'unknown' };
}
export function artifactsFailure(error: unknown): Error {
    const failure = error instanceof Error ? error : new Error('artifacts-provider-failed');
    Object.defineProperty(failure, 'dependency', { value: 'artifacts', configurable: true });
    return failure;
}
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const telemetryIdFormats = [
    /^task-[a-zA-Z0-9_-]{43}$/,
    new RegExp(`^${uuid}$`, 'i'),
    new RegExp(`^${uuid}:checks$`, 'i'),
    new RegExp(`^receipt-export-${uuid}$`, 'i'),
    new RegExp(`^source-verify-${uuid}$`, 'i'),
    new RegExp(`^lane-verify-${uuid}$`, 'i'),
    new RegExp(`^${uuid}:head:${uuid}$`, 'i'),
    new RegExp(`^push:${uuid}$`, 'i'),
];
export function safeTelemetryId(value: unknown): string | undefined {
    return typeof value === 'string' && value.length <= 80 && telemetryIdFormats.some(format => format.test(value))
        ? value : undefined;
}
export function telemetryId(value: unknown): string | undefined {
    return value === undefined || value === null ? undefined : safeTelemetryId(value) ?? 'unrecognized-format';
}
export function logHttpFailure(error: unknown, route: string, requestId: string, status: number, taskId?: unknown, runId?: unknown) {
    const safeTaskId = telemetryId(taskId);
    const safeRunId = telemetryId(runId);
    console.warn(JSON.stringify({ message: 'http-request-failed', ...sanitizedFailure(error), route, requestId, status,
        ...(safeTaskId ? { taskId: safeTaskId } : {}), ...(safeRunId ? { runId: safeRunId } : {}) }));
}
