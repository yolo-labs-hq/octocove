/** Hoist global options without moving tokens past the positional separator. */
export function globalOptions(input: string[]): { argv: string[]; flags: string[]; help: boolean } {
  const argv: string[] = [], flags: string[] = [];
  let help = false;
  for (let i = 0; i < input.length; i++) {
    const arg = input[i]!;
    if (arg === '--') { argv.push(...input.slice(i)); break; }
    if (arg === '--help') { help = true; continue; }
    if (arg === '--json' || arg === '--verbose' || arg.startsWith('--idempotency-key=')) { flags.push(arg); continue; }
    if (arg === '--idempotency-key') {
      flags.push(arg);
      if (input[i+1] !== undefined && !input[i+1]!.startsWith('--')) flags.push(input[++i]!);
      continue;
    }
    argv.push(arg);
  }
  return { argv, flags, help };
}
