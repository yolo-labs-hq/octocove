import type { components } from '../../client/src/generated/openapi.js';
import type { Journeys } from './http.js';
import { ConfigError } from './config.js';

type Membership = components['schemas']['Me']['memberships'][number];
type Repository = Awaited<ReturnType<Journeys['repositories']['list']>>[number];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function cloneProject(memberships: readonly Membership[], selector: string): Membership {
  // Match the server's project segment rule: UUIDs are IDs; other segments prefer a slug.
  const project = uuid.test(selector) ? memberships.find(p => p.projectId === selector)
    : memberships.find(p => p.slug === selector) ?? memberships.find(p => p.projectId === selector);
  if (!project) throw new ConfigError('You are not a member of this project. Check the project name or ask a project admin to add you.');
  if (!project.verbs.includes('tasks:read')) throw new ConfigError('Reading this repository requires tasks:read. Ask a project admin for read access.');
  return project;
}

export function cloneRepositorySelection(repositories: readonly Repository[], projectId: string, selector?: string): Repository {
  const items = repositories.filter(r => r.projectId === projectId && r.role === 'canonical');
  const matches = selector === undefined ? items : items.filter(r => r.id === selector || r.name === selector || r.repoId === selector);
  if (matches.length !== 1) {
    const choices = items.map(r => `${r.id} (${r.name}, ${r.targetRef})`).join('; ');
    throw new ConfigError(!items.length ? 'This project has no canonical repository. Ask a project admin to create one first.'
      : !matches.length ? `Repository not found in this project. Available repositories: ${choices}`
      : `Choose a repository explicitly: octocove repo clone PROJECT REPOSITORY [DIR]. Available repositories: ${choices}`);
  }
  const r = matches[0]!;
  if (r.verification !== 'verified') throw new ConfigError('This repository is not verified. Ask a project admin to verify it before cloning.');
  if (r.importState && r.importState !== 'ready') throw new ConfigError('This repository is not ready. Check repo list after its import finishes.');
  if (!/^refs\/heads\/.+/.test(r.targetRef) || /[\x00-\x20\x7f~^:?*\[\\]/.test(r.targetRef) || r.targetRef.includes('..') || r.targetRef.includes('@{') || r.targetRef.endsWith('/') || r.targetRef.endsWith('.'))
    throw new ConfigError('The repository target is not a valid branch. Ask a project admin to check its target ref.');
  return r;
}
