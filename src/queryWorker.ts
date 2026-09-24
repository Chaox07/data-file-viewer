import { fork, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { mkdtempSync, chmodSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { QUERY_LIMITS, QueryPolicyError, readerThreads } from './queryPolicy';

interface Reply { id: number; value?: unknown; error?: string }
export class QueryWorkerOperationError extends QueryPolicyError {
  constructor(message: string, readonly metadata: unknown) { super(message); }
}

interface Process { child: ChildProcess; tempRoot: string }
interface Spare extends Process { workerPath: string; release: () => void }

/** Remove a private scratch directory once its process (if any) has exited. */
function removeTempRoot(child: ChildProcess | undefined, tempRoot: string): void {
  const cleanup = () => { void rm(tempRoot, { recursive: true, force: true }).catch(() => undefined); };
  if (child && child.exitCode === null && child.signalCode === null) child.once('exit', cleanup);
  else cleanup();
}

/** A reader process: filtered environment, private scratch directory, IPC only. */
function spawnReader(workerPath: string): Process {
  // Do not copy arbitrary environment variables (which can contain tokens).
  const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1' };
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  // Each side query of a text-column probe runs on its own libuv thread
  // (see sideQueries); size the pool to the reader's share of the machine.
  env.UV_THREADPOOL_SIZE = String(Math.max(4, readerThreads() + 1));
  const tempRoot = mkdtempSync(join(tmpdir(), 'dfv-query-'));
  try {
    chmodSync(tempRoot, 0o700);
    env.TMPDIR = env.TEMP = env.TMP = tempRoot;
    const child = fork(workerPath, [], {
      env, execArgv: ['--max-old-space-size=512'], serialization: 'advanced',
      cwd: tempRoot,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    return { child, tempRoot };
  } catch {
    removeTempRoot(undefined, tempRoot);
    throw new QueryPolicyError('Query worker could not start.');
  }
}

/** Parent-owned request identity and hard deadlines. This process boundary is
 * deliberately independent of engine capability controls: neither replaces the other.
 */
export class QueryWorker {
  private static readonly workers = new Set<QueryWorker>();
  /**
   * One reader process started ahead of need, so the next open (a new tab,
   * the reopen after an edit, a refresh, the restart after Cancel) does not
   * wait ~50 ms for fork and module load. It has opened nothing: it is the
   * same process a fresh fork would give, only earlier. It is not counted
   * toward the four-reader cap, never keeps the host alive, and is killed
   * when the last document closes.
   */
  private static spare?: Spare;
  private static live = 0;
  private child?: ChildProcess;
  private sequence = 0;
  private generation = 0;
  private disposed = false;
  private tempRoot?: string;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(private readonly workerPath = join(__dirname, 'queryWorkerEntry.js')) { QueryWorker.live++; }

  get running(): boolean { return this.child !== undefined; }

  /** Hand over the spare if it is alive and runs the same entry point. */
  private static claimSpare(workerPath: string): Process | undefined {
    const spare = QueryWorker.spare;
    if (!spare || spare.workerPath !== workerPath) return undefined;
    QueryWorker.spare = undefined;
    spare.release();
    const { child } = spare;
    if (child.exitCode !== null || child.signalCode !== null || !child.connected) {
      child.kill('SIGKILL');
      removeTempRoot(child, spare.tempRoot);
      return undefined;
    }
    child.ref();
    (child.channel as { ref?: () => void } | undefined)?.ref?.();
    return spare;
  }

  /** Start the next spare after this one's work settles, if documents are still open. */
  private static replenish(workerPath: string): void {
    if (QueryWorker.spare || QueryWorker.live === 0) return;
    let spare: Process;
    try { spare = spawnReader(workerPath); } catch { return; }
    const { child, tempRoot } = spare;
    const lost = () => {
      if (QueryWorker.spare?.child !== child) return;
      QueryWorker.spare = undefined;
      child.kill('SIGKILL');
      removeTempRoot(child, tempRoot);
    };
    child.once('exit', lost);
    child.once('error', lost);
    // An idle spare must never keep the extension host (or a test run) alive.
    child.unref();
    (child.channel as { unref?: () => void } | undefined)?.unref?.();
    QueryWorker.spare = { child, tempRoot, workerPath, release: () => { child.off('exit', lost); child.off('error', lost); } };
  }

  /** Kill the spare; called when the last document closes and on deactivate. */
  static releaseSpare(): void {
    const spare = QueryWorker.spare;
    if (!spare) return;
    QueryWorker.spare = undefined;
    spare.release();
    spare.child.kill('SIGKILL');
    removeTempRoot(spare.child, spare.tempRoot);
  }

  private start(): ChildProcess {
    if (this.disposed) throw new QueryPolicyError('This query view is closed.');
    if (this.child) return this.child;
    if (QueryWorker.workers.size >= 4) {
      const idle = [...QueryWorker.workers].find(worker => worker.pending.size === 0);
      if (idle) idle.stop('Idle query runtime released.');
      else throw new QueryPolicyError('Four query runtimes are busy. Wait for a query to finish.');
    }
    const generation = ++this.generation;
    const { child, tempRoot } = QueryWorker.claimSpare(this.workerPath) ?? spawnReader(this.workerPath);
    this.tempRoot = tempRoot;
    this.child = child;
    QueryWorker.workers.add(this);
    child.on('message', (reply: Reply) => {
      if (generation !== this.generation || !reply || !Number.isSafeInteger(reply.id)) return;
      const request = this.pending.get(reply.id);
      if (!request) return;
      this.pending.delete(reply.id);
      clearTimeout(request.timer);
      if (this.pending.size === 0) setImmediate(() => QueryWorker.replenish(this.workerPath));
      if (typeof reply.error === 'string') request.reject(new QueryPolicyError(reply.error));
      else {
        const envelope = reply.value as { error?: string; metadata?: unknown } | undefined;
        if (envelope?.metadata && typeof envelope.error === 'string') request.reject(new QueryWorkerOperationError(envelope.error, envelope.metadata));
        else request.resolve(reply.value);
      }
    });
    child.once('error', () => { if (generation === this.generation) this.stop('Query worker could not start.'); });
    child.once('exit', () => { if (generation === this.generation) this.stop('Query worker stopped. Run the query again.'); });
    return child;
  }

  call<T>(method: string, args: unknown[], deadlineMs: number = QUERY_LIMITS.deadlineMs): Promise<T> {
    if (this.pending.size >= QUERY_LIMITS.queuedRequests) {
      return Promise.reject(new QueryPolicyError('Too many queued queries. Wait for the current query or cancel it.'));
    }
    return new Promise<T>((resolve, reject) => {
      const child = this.start();
      const id = ++this.sequence;
      const timer = setTimeout(() => this.stop('Query timed out. Reduce the query and try again.'), deadlineMs);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      child.send({ id, method, args }, error => {
        if (error) this.stop('Query worker communication failed.');
      });
    });
  }

  cancel(): void {
    if (!this.child || this.pending.size === 0) return;
    this.child.send({ method: 'cancel' }, () => undefined);
    // Ingestion helpers can catch an interrupt and continue. Invalidate replies
    // and terminate this read-only process immediately, so Cancel never paints a
    // late success. Saves run outside this worker. The next query rebuilds caches.
    this.stop('Query cancelled.');
  }

  stop(reason = 'Query cancelled.'): void {
    const child = this.child;
    const tempRoot = this.tempRoot;
    this.tempRoot = undefined;
    this.child = undefined;
    QueryWorker.workers.delete(this);
    this.generation++;
    child?.kill('SIGKILL');
    if (tempRoot) removeTempRoot(child, tempRoot);
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new QueryPolicyError(reason));
    }
    this.pending.clear();
  }

  dispose(): void {
    if (!this.disposed && --QueryWorker.live === 0) QueryWorker.releaseSpare();
    this.disposed = true;
    this.stop('This query view is closed.');
  }

  /** Wait for the OS to release native file handles before a trusted save opens. */
  async close(): Promise<void> {
    const child = this.child;
    const exited = child && child.exitCode === null && child.signalCode === null
      ? new Promise<void>(resolve => child.once('exit', () => resolve()))
      : Promise.resolve();
    this.stop('Query runtime closed.');
    await exited;
  }
}
