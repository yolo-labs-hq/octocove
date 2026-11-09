/** Public repository coordinates only. Credential-bearing remote text is never retained. */
export interface GitHubRepositoryName { readonly owner: string; readonly name: string }
export function githubRepositoryName(owner: string, name: string): GitHubRepositoryName {
  if (![owner, name].every(v => /^[A-Za-z0-9._-]{1,100}$/.test(v) && v !== '.' && v !== '..')) throw new Error('Invalid GitHub repository coordinates');
  return { owner, name };
}
/** Infer only the project's URL slug; preserve repository coordinates and explicit slugs. */
export function defaultGitHubProjectSlug(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63).replace(/-+$/g, '') || 'repository';
  if (slug.length < 2 || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(slug)) return `${slug}-repo`;
  return slug;
}
export function parseGitHubRemote(remote: string): GitHubRepositoryName | null {
  try {
    if (/[\\\u0000-\u0020\u007f]/.test(remote)) return null;
    let path: string;
    const scp = /^git@github\.com:([^?#]+)$/i.exec(remote);
    if (scp) path = scp[1]!;
    else {
      // Remove authority userinfo before URL parsing; it is never retained in a result.
      const clean = remote.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, '$1');
      const url = new URL(clean);
      if (url.hostname.toLowerCase() !== 'github.com' || url.port || !['https:', 'ssh:'].includes(url.protocol) || url.search || url.hash) return null;
      path = url.pathname.slice(1);
    }
    const parts = path.replace(/\.git$/, '').split('/');
    return parts.length === 2 ? githubRepositoryName(parts[0]!, parts[1]!) : null;
  } catch { return null; }
}
export interface InstallationCandidate { readonly installationId: string }
export type InstallationResolution = InstallationCandidate | { readonly state: 'none' | 'multiple'; readonly candidates: readonly InstallationCandidate[]; readonly connectUrlHint: string };
export class GitHubInstallationResolutionError extends Error {
  readonly code = 'github-installation-resolution-required';
  constructor(readonly resolution: Exclude<InstallationResolution, InstallationCandidate>) {
    super(`${resolution.state === 'none' ? 'Connect GitHub for this repository first' : 'Choose a GitHub installation explicitly'}: ${resolution.connectUrlHint}`);
    this.name = 'GitHubInstallationResolutionError';
  }
}
