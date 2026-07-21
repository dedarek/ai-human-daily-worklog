import { readFile, writeFile } from "node:fs/promises";

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
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch { return fallback; }
}

// 读-改-写在 per-path 串行锁内完成，杜绝 published/wiki-index/meetings 的丢失更新。
export function updateJson<T>(path: string, fallback: T, mutator: (data: T) => T | Promise<T>): Promise<T> {
  return lockFor(path)(async () => {
    const data = await readJson(path, fallback);
    const next = await mutator(data);
    await writeFile(path, JSON.stringify(next, null, 2), { mode: 0o600 });
    return next;
  });
}
