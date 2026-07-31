import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";

// 通用串行工具：保证同一 key 上的异步任务按提交顺序依次执行，避免并发写覆盖。
export function createMutex() {
  let tail: Promise<unknown> = Promise.resolve();
  return function run<T>(fn: () => Promise<T>): Promise<T> {
    const result = tail.then(fn, fn);
    tail = result.catch(() => {});
    return result;
  };
}

const fileLocks = new Map<string, ReturnType<typeof createMutex>>();
function lockFor(path: string) {
  let mutex = fileLocks.get(path);
  if (!mutex) { mutex = createMutex(); fileLocks.set(path, mutex); }
  return mutex;
}

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  let raw: string;
  try { raw = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
  try { return JSON.parse(raw) as T; }
  catch (error) { throw new Error(`状态文件已损坏，已停止覆盖：${path}`, { cause: error }); }
}

export async function atomicWriteFile(path: string, content: string | Buffer, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode });
  const handle = await open(temporary, "r+");
  try { await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
  const directory = await open(dirname(path), "r").catch(() => null);
  if (directory) try { await directory.sync(); } finally { await directory.close(); }
}

async function withFileLock<T>(path: string, action: () => Promise<T>) {
  const lock = `${path}.lock`;
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      const handle = await open(lock, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      try { return await action(); }
      finally { await handle.close(); await unlink(lock).catch(() => {}); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = await readFile(lock, "utf8").then(raw => JSON.parse(raw).pid as number).catch(() => 0);
      let alive = false;
      if (Number.isInteger(owner) && owner > 1) try { process.kill(owner, 0); alive = true; } catch { /* stale owner */ }
      const age = await stat(lock).then(info => Date.now() - info.mtimeMs).catch(() => 0);
      if (!alive && age > 10_000 || age > 10 * 60_000) { await unlink(lock).catch(() => {}); continue; }
      if (Date.now() >= deadline) throw new Error(`状态文件正被另一个 Worklog 进程占用：${path}`);
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  }
}

// 读-改-写在 per-path 串行锁内完成，杜绝 published/wiki-index/meetings 的丢失更新。
export function updateJson<T>(path: string, fallback: T, mutator: (data: T) => T | Promise<T>): Promise<T> {
  return lockFor(path)(() => withFileLock(path, async () => {
    const data = await readJson(path, fallback);
    const next = await mutator(data);
    await atomicWriteFile(path, JSON.stringify(next, null, 2));
    return next;
  }));
}
