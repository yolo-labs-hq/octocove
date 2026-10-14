import { readFileSync } from 'node:fs';
import Ajv from 'ajv/dist/2020';
import { parse } from 'yaml';
import { expect } from 'vitest';
const spec = parse(readFileSync(new URL('../../../spec/openapi.yaml', import.meta.url), 'utf8'));
const ajv = new Ajv({ strict: false, allErrors: true });
const validators = new Map<string, ReturnType<typeof ajv.compile>>();
export function repositorySchema(name: 'Repository' | 'RepositoryVerification' | 'RepositoryList', body: unknown) {
    if (!validators.has(name))
        validators.set(name, ajv.compile({
            ...spec.components.schemas[name], components: spec.components,
        }));
    const validate = validators.get(name)!;
    expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
}
