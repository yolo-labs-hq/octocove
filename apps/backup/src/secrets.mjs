import { constants, closeSync, fstatSync, openSync, readSync } from 'node:fs';

export function failure(code, message = code) {
  return Object.assign(new Error(message), { code });
}

/** Environment/config carry only paths or descriptor numbers, never secret values. */
export function readSecret({ file, fd } = {}) {
  if ((file === undefined) === (fd === undefined)) throw failure('INVALID_SECRET_INPUT');
  let handle;
  try {
    if (file !== undefined) handle = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    else {
      if (!/^\d+$/.test(String(fd)) || Number(fd) < 3) throw failure('INVALID_SECRET_INPUT');
      handle = Number(fd);
    }
    const info = fstatSync(handle);
    if (!info.isFile() || (info.mode & 0o077) || info.uid !== process.getuid()) throw failure('SECRET_NOT_PRIVATE');
    if (info.size > 65536) throw failure('INVALID_SECRET_INPUT');
    const bytes = Buffer.alloc(info.size);
    const length = readSync(handle, bytes, 0, bytes.length, 0);
    const value = bytes.subarray(0, length).toString('utf8').trimEnd();
    if (!value || /[\r\n\0]/.test(value)) throw failure('INVALID_SECRET_INPUT');
    return value;
  } catch (e) {
    if (['INVALID_SECRET_INPUT', 'SECRET_NOT_PRIVATE'].includes(e.code)) throw e;
    throw failure('SECRET_READ_FAILED');
  } finally { if (file !== undefined && handle !== undefined) closeSync(handle); }
}

export function envSecret(name, env = process.env) {
  if (env[name] !== undefined) throw failure('SECRET_VALUE_IN_ENV');
  return readSecret({ file: env[`${name}_FILE`], fd: env[`${name}_FD`] });
}

export function childEnv(env = process.env) {
  const out = { PATH: env.PATH ?? '/usr/bin:/bin', HOME: '/nonexistent' };
  for (const name of ['LANG', 'LC_ALL', 'TZ']) if (env[name] !== undefined) out[name] = env[name];
  return out;
}
