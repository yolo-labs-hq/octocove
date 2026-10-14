export function checksSatisfyPolicy(policy: {
    kind?: unknown;
    mode?: unknown;
} | null, checkIdentity: string, latestCheck: {
    result: string;
    check_identity: string;
} | null): boolean {
    if (policy?.kind === "none" || policy?.mode === "none")
        return true;
    return (latestCheck?.result === "passed" &&
        latestCheck.check_identity === checkIdentity);
}
export interface CheckEvidence {
    version: 1;
    commands: {
        argv: string[];
        exitCode: number;
    }[];
}
export function isCheckEvidence(value: unknown): value is CheckEvidence {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const evidence = value as CheckEvidence;
    return evidence.version === 1 && Array.isArray(evidence.commands) &&
        evidence.commands.every(command => command && typeof command === "object" &&
            !Array.isArray(command) && Array.isArray(command.argv) && command.argv.length > 0 &&
            command.argv.every(arg => typeof arg === "string") && Number.isInteger(command.exitCode));
}
