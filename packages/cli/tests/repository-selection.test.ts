import { expect, it } from 'vitest';
import { cloneProject, cloneRepositorySelection } from '../src/repository-selection.js';
const membership = { projectId:'P1',slug:'tools',name:'Tools',verbs:['tasks:read'],artifactsNamespace:'ns' };
const repository = { id:'R1',projectId:'P1',provider:'artifacts' as const,namespace:'ns',repoId:'tools',name:'tools',role:'canonical' as const,targetRef:'refs/heads/main',knownHeadSha:null,verification:'verified' as const,verifiedAt:null,importState:null,lanePolicy:{candidatePublication:'repository-readers' as const,visibility:'private' as const} };
it('resolves project slugs and IDs without inventing membership',()=>{
  expect(cloneProject([membership],'tools')).toBe(membership);expect(cloneProject([membership],'P1')).toBe(membership);
  expect(()=>cloneProject([],'tools')).toThrow(/not a member/);
  expect(()=>cloneProject([{...membership,verbs:[]}],'tools')).toThrow(/tasks:read/);
});
it('chooses the only canonical or a named repository, including an empty canonical',()=>{
  expect(cloneRepositorySelection([repository],'P1')).toBe(repository);
  expect(cloneRepositorySelection([repository],'P1','R1')).toBe(repository);
  expect(cloneRepositorySelection([repository],'P1','tools')).toBe(repository);
  expect(()=>cloneRepositorySelection([repository],'other')).toThrow(/no canonical/);
});
it('lists choices rather than guessing between several repositories',()=>{
  const second={...repository,id:'R2',name:'more',repoId:'more'};
  expect(()=>cloneRepositorySelection([repository,second],'P1')).toThrow(/R1.*R2/);
  expect(cloneRepositorySelection([repository,second],'P1','R2')).toBe(second);
  expect(()=>cloneRepositorySelection([repository,second],'P1','missing')).toThrow(/Repository not found/);
});
it('refuses unverified and unfinished canonical repositories',()=>{
  expect(()=>cloneRepositorySelection([{...repository,verification:'unverified'}],'P1')).toThrow(/not verified/);
  expect(()=>cloneRepositorySelection([{...repository,importState:'importing'}],'P1')).toThrow(/not ready/);
});
