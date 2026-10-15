import { isAbsolute, resolve } from 'node:path';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ConfigError } from './config.js';
import { baseUrlOf } from './http.js';
import { checkBaseUrl } from '../../client/src/client.js';

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
export function canonicalReadUrl(apiUrl: string, projectId: string, repositoryId: string) {
  return `${checkBaseUrl(baseUrlOf(apiUrl))}/v1/projects/${encodeURIComponent(projectId)}/repositories/${encodeURIComponent(repositoryId)}/git`;
}
export function humanCredentialPath() { return fileURLToPath(new URL('./octocove-human-credential.mjs',import.meta.url)); }
export async function humanGitConfig(url: string, configDirectory: string, helperPath = humanCredentialPath()) {
  if(!isAbsolute(helperPath) || /[\r\n\0]/.test(helperPath+configDirectory+url+process.execPath))throw new ConfigError('Invalid human Git helper binding.');
  try {if(!(await stat(helperPath)).isFile())throw new Error();await access(helperPath,constants.R_OK);await access(process.execPath,constants.X_OK);}
  catch {throw new ConfigError('Bundled human credential helper is missing or unreadable. Reinstall the CLI before cloning.');}
  const command=`!${quote(process.execPath)} ${quote(helperPath)} --config-dir ${quote(resolve(configDirectory))} --url ${quote(url)}`;
  return [
    [`credential.${url}.helper`, ''], // Reset inherited helpers, including store/cache helpers.
    [`credential.${url}.helper`, command],
    [`credential.${url}.useHttpPath`, 'true'],
    [`credential.${url}.username`, 'octocove'],
    [`http.${url}.followRedirects`, 'false'],
    [`http.${url}.extraHeader`, ''],
    [`http.${url}.cookieFile`, ''],
    [`http.${url}.saveCookies`, 'false'],
    [`http.${url}.sslVerify`, 'true'],
  ] as const;
}
