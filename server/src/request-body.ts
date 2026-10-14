import { AuthError } from './auth';
export const JSON_BODY_MAX_BYTES = 1048576;
export const JSON_BODY_DEADLINE_MS = 10000;
export async function readJsonBody(request: Request, max = JSON_BODY_MAX_BYTES, deadlineMs = JSON_BODY_DEADLINE_MS): Promise<Record<string, unknown>> {
    return (await readJsonCommand(request, max, deadlineMs)).body;
}
export async function readJsonCommand(request: Request, max = JSON_BODY_MAX_BYTES, deadlineMs = JSON_BODY_DEADLINE_MS) {
    const length = request.headers.get('content-length');
    if (length !== null && /^\d+$/.test(length) && Number(length) > max)
        throw new AuthError('request-body-too-large', 413);
    if (!request.body)
        throw new AuthError('invalid-request', 400);
    const reader = request.body.getReader();
    const bytes = new Uint8Array(max);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let onAbort: (() => void) | undefined;
    const interrupted = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AuthError('request-body-timeout', 408)), deadlineMs);
        onAbort = () => reject(new AuthError('request-disconnected', 400));
        request.signal.addEventListener('abort', onAbort, { once: true });
        if (request.signal.aborted)
            onAbort();
    });
    try {
        const size = await Promise.race([readAll(), interrupted]);
        const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes.subarray(0, size)));
        if (!body || typeof body !== 'object' || Array.isArray(body))
            throw new Error('expected-object');
        return { body: body as Record<string, unknown>, bytes: bytes.subarray(0, size) };
    }
    catch (error) {
        void reader.cancel().catch(() => { });
        if (error instanceof AuthError)
            throw error;
        throw new AuthError('invalid-request', 400);
    }
    finally {
        clearTimeout(timer);
        if (onAbort)
            request.signal.removeEventListener('abort', onAbort);
        reader.releaseLock();
    }
    async function readAll(): Promise<number> {
        let size = 0;
        for (;;) {
            const next = await reader.read();
            if (next.done)
                return size;
            if (next.value.byteLength > max - size)
                throw new AuthError('request-body-too-large', 413);
            bytes.set(next.value, size);
            size += next.value.byteLength;
        }
    }
}
