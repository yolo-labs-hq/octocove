/** Hoist global options without moving tokens past the positional separator. */
export function globalOptions(input: string[]): { argv: string[]; flags: string[]; help: boolean; org: string | undefined } {
  const argv: string[] = [], flags: string[] = [];
  let help = false;
  for (let i = 0; i < input.length; i++) {
    const arg = input[i]!;
    if (arg === '--') { argv.push(...input.slice(i)); break; }
    if (arg === '--help') { help = true; continue; }
    if (arg === '--json' || arg === '--verbose' || arg.startsWith('--idempotency-key=')) { flags.push(arg); continue; }
    if (arg.startsWith('--org=')) { flags.push(arg); continue; }
    if (arg === '--idempotency-key' || arg === '--org') {
      flags.push(arg);
      if (input[i+1] !== undefined && !input[i+1]!.startsWith('--')) flags.push(input[++i]!);
      continue;
    }
    argv.push(arg);
  }
  // The last --org wins, like any repeated option.
  let org: string | undefined;
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === '--org') org = flags[i + 1]?.startsWith('--') ? undefined : flags[++i];
    else if (flags[i]!.startsWith('--org=')) org = flags[i]!.slice('--org='.length);
  }
  return { argv, flags, help, org };
}
