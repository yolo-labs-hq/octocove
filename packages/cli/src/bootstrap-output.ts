import { constants } from 'node:fs';
import { lstat, mkdir, open, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, basename, parse, resolve, join } from 'node:path';
import { ConfigError } from './config.js';

/** Reserve before issuing authority. Never replace a file or follow a symlink. */
export async function reserveBootstrap(destination: string) {
  const path = resolve(destination), parent = dirname(path), root = parse(path).root;
  let dir = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let walked = root;
  const ancestors: { path: string; dev: number; ino: number }[] = [];
  let file: FileHandle | undefined, committed = false;
  const anchored = (name: string) => process.platform === 'linux' ? join(`/proc/self/fd/${dir.fd}`, name) : join(walked, name);
  try {
    for (const part of parent.slice(root.length).split('/').filter(Boolean)) {
      const child = anchored(part);
      try { await mkdir(child, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const info = await lstat(child);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new ConfigError('Bootstrap output directories must not contain symlinks.');
      const next = await open(child, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const opened = await next.stat();
      if (opened.dev !== info.dev || opened.ino !== info.ino) { await next.close(); throw new ConfigError('Bootstrap output directory changed; choose a private directory.'); }
      await dir.close(); dir = next; walked = join(walked, part);
      ancestors.push({ path: walked, dev: opened.dev, ino: opened.ino });
    }
    const verify = async () => {
      if (process.platform !== 'linux') for (const original of ancestors) {
        const now = await lstat(original.path);
        if (!now.isDirectory() || now.isSymbolicLink() || now.dev !== original.dev || now.ino !== original.ino) throw new ConfigError('Bootstrap output directory changed; choose a private directory.');
      }
    };
    await verify();
    const info = await dir.stat();
    if ((info.mode & 0o777) !== 0o700 || (process.getuid && info.uid !== process.getuid())) throw new ConfigError('Bootstrap output parent must be owned by you with mode 0700; choose a private directory outside all working trees.');
    file = await open(anchored(basename(path)), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await file.chmod(0o600);
    await verify();
    const reserved = file;
    return {
      path,
      async write(value: unknown) {
        await verify();
        const named = await lstat(anchored(basename(path))), original = await reserved.stat();
        if (named.isSymbolicLink() || named.dev !== original.dev || named.ino !== original.ino) throw new ConfigError('Bootstrap output file changed; retry with a new private path and the same idempotency key.');
        // The descriptor, not the pathname, receives the secret even if the name is exchanged.
        await reserved.writeFile(JSON.stringify(value)); await reserved.sync(); await dir.sync(); committed = true;
      },
      async close() {
        try {
          if (!committed) {
            const current = await lstat(anchored(basename(path))).catch(()=>undefined), original = await reserved.stat();
            if (current?.dev === original.dev && current?.ino === original.ino) await unlink(anchored(basename(path)));
          }
        } finally { await reserved.close(); await dir.close(); }
      },
    };
  } catch {
    await file?.close(); await dir.close();
    throw new ConfigError('Cannot reserve bootstrap output: use a new file in a private 0700 directory with no symlinks.');
  }
}
