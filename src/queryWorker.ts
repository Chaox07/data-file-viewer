import { fork, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { mkdtempSync, chmodSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { QUERY_LIMITS, QueryPolicyError } from './queryPolicy';

interface Reply { id: number; value?: unknown; error?: string }
export class QueryWorkerOperationError extends QueryPolicyError {
  constructor(message: string, readonly metadata: unknown) { super(message); }
}

/** Parent-owned request identity and hard deadlines. This process boundary is
 * deliberately independent of engine capability controls: neither replaces the other.
 */
export class QueryWorker {
  private static readonly workers = new Set<QueryWorker>();
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

  constructor(private readonly workerPath = join(__dirname, 'queryWorkerEntry.js')) {}

  get running(): boolean { return this.child !== undefined; }

  private start(): ChildProcess {
    if (this.disposed) throw new QueryPolicyError('This query view is closed.');
    if (this.child) return this.child;
    if (QueryWorker.workers.size >= 4) {
      const idle = [...QueryWorker.workers].find(worker => worker.pending.size === 0);
      if (idle) idle.stop('Idle query runtime released.');
      else throw new QueryPolicyError('Four query runtimes are busy. Wait for a query to finish.');
    }
    const generation = ++this.generation;
    // Do not copy arbitrary environment variables (which can contain tokens).
    const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1' };
    for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    this.tempRoot = mkdtempSync(join(tmpdir(), 'dfv-query-'));
    chmodSync(this.tempRoot, 0o700);
    env.TMPDIR = env.TEMP = env.TMP = this.tempRoot;
    let child: ChildProcess;
    try {
      child = fork(this.workerPath, [], {
        env, execArgv: ['--max-old-space-size=512'], serialization: 'advanced',
        cwd: this.tempRoot,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
    } catch {
      this.stop('Query worker could not start.');
      throw new QueryPolicyError('Query worker could not start.');
    }
    this.child = child;
    QueryWorker.workers.add(this);
    child.on('message', (reply: Reply) => {
      if (generation !== this.generation || !reply || !Number.isSafeInteger(reply.id)) return;
      const request = this.pending.get(reply.id);
      if (!request) return;
      this.pending.delete(reply.id);
      clearTimeout(request.timer);
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
    if (tempRoot) {
      const cleanup = () => { void rm(tempRoot, { recursive: true, force: true }).catch(() => undefined); };
      if (child && child.exitCode === null && child.signalCode === null) child.once('exit', cleanup);
      else cleanup();
    }
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new QueryPolicyError(reason));
    }
    this.pending.clear();
  }

  dispose(): void { this.disposed = true; this.stop('This query view is closed.'); }

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
