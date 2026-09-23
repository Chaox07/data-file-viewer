import { fork, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { QUERY_LIMITS, QueryPolicyError } from './queryPolicy';

interface Reply { id: number; value?: unknown; error?: string }

/** Parent-owned request identity and hard deadlines. This process boundary is
 * deliberately independent of engine capability controls: neither replaces the other.
 */
export class QueryWorker {
  private child?: ChildProcess;
  private sequence = 0;
  private generation = 0;
  private disposed = false;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(private readonly workerPath = join(__dirname, 'queryWorkerEntry.js')) {}

  private start(): ChildProcess {
    if (this.disposed) throw new QueryPolicyError('This query view is closed.');
    if (this.child) return this.child;
    const generation = ++this.generation;
    // Do not copy arbitrary environment variables (which can contain tokens).
    const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1' };
    for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const child = fork(this.workerPath, [], {
      env, execArgv: [], serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    this.child = child;
    child.on('message', (reply: Reply) => {
      if (generation !== this.generation || !reply || !Number.isSafeInteger(reply.id)) return;
      const request = this.pending.get(reply.id);
      if (!request) return;
      this.pending.delete(reply.id);
      clearTimeout(request.timer);
      if (typeof reply.error === 'string') request.reject(new QueryPolicyError(reply.error));
      else request.resolve(reply.value);
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
    // A native call can ignore interrupt; the parent still owns the deadline.
    const generation = this.generation;
    const timer = setTimeout(() => {
      if (generation === this.generation && this.pending.size) this.stop('Query cancelled.');
    }, QUERY_LIMITS.cancelDeadlineMs);
    timer.unref();
  }

  stop(reason = 'Query cancelled.'): void {
    const child = this.child;
    this.child = undefined;
    this.generation++;
    child?.kill('SIGKILL');
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
