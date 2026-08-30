import Module from 'node:module';
import { basename, dirname, join } from 'node:path';

/**
 * A `vscode` module for code that runs outside the extension host.
 *
 * `duckdbEditorProvider.ts` is 1411 lines and had no tests at all, for one
 * mechanical reason: it imports `vscode`, which only exists inside VS Code, so
 * `tsconfig.test.json` excluded it and every property it holds -- the
 * connection lock, the stats cache, the sibling resolution, the whole message
 * flow -- went unexercised. This is what makes it reachable.
 *
 * Types come from `@types/vscode`, which is already a devDependency, so
 * nothing here needs to describe the API's shape. What is needed is a RUNTIME
 * module, because tsc emits `require("vscode")` verbatim and tsconfig `paths`
 * does not rewrite emitted specifiers. Hence the `Module._load` patch: it is
 * installed when this file is imported, so importing it BEFORE anything that
 * reaches the provider is what makes the require resolve.
 *
 * Deliberately not a mocking framework. Everything is a plain object, and the
 * only cleverness is that the three `show*Message` functions record what they
 * were called with -- because "was the user actually told" is an assertion
 * this suite makes repeatedly, and it is the one thing a null stub would
 * silently pass.
 */

export interface RecordedMessage {
  level: 'info' | 'warning' | 'error';
  text: string;
  items: string[];
}

/** Everything the stub saw, for tests to assert on. */
export const recorded: {
  messages: RecordedMessage[];
  outputLines: string[];
  commands: Map<string, (...args: unknown[]) => unknown>;
  executed: { command: string; args: unknown[] }[];
} = {
  messages: [],
  outputLines: [],
  commands: new Map(),
  executed: [],
};

/** Settings the code under test reads. Set before exercising a path that cares. */
export const settings = new Map<string, unknown>();

export function resetVscodeStub(): void {
  recorded.messages.length = 0;
  recorded.outputLines.length = 0;
  recorded.executed.length = 0;
  recorded.commands.clear();
  settings.clear();
}

/** Messages shown since the last reset, newest last. */
export function shownMessages(): string[] {
  return recorded.messages.map((m) => m.text);
}

class StubUri {
  private constructor(readonly fsPath: string) {}
  static file(path: string): StubUri {
    return new StubUri(path);
  }
  static joinPath(base: StubUri, ...segments: string[]): StubUri {
    return new StubUri(join(base.fsPath, ...segments));
  }
  get path(): string {
    return this.fsPath;
  }
  get scheme(): string {
    return 'file';
  }
  toString(): string {
    return `file://${this.fsPath}`;
  }
  with(): StubUri {
    return this;
  }
}

class StubDisposable {
  constructor(private readonly callOnDispose: () => void = () => undefined) {}
  dispose(): void {
    this.callOnDispose();
  }
  static from(...items: { dispose(): unknown }[]): StubDisposable {
    return new StubDisposable(() => {
      for (const item of items) item.dispose();
    });
  }
}

function record(level: RecordedMessage['level']) {
  return (text: string, ...items: unknown[]): Promise<string | undefined> => {
    // VS Code's own overloads allow an options object first; the provider does
    // not use that form, so anything non-string is dropped rather than guessed
    // at -- a stub that quietly reinterprets its arguments is worse than one
    // that does less.
    recorded.messages.push({ level, text, items: items.filter((i): i is string => typeof i === 'string') });
    return Promise.resolve(undefined);
  };
}

export const vscodeStub = {
  Uri: StubUri,
  Disposable: StubDisposable,

  window: {
    createOutputChannel(name: string) {
      return {
        name,
        appendLine: (line: string) => {
          recorded.outputLines.push(line);
        },
        append: (text: string) => {
          recorded.outputLines.push(text);
        },
        show: () => undefined,
        hide: () => undefined,
        clear: () => {
          recorded.outputLines.length = 0;
        },
        dispose: () => undefined,
      };
    },
    showInformationMessage: record('info'),
    showWarningMessage: record('warning'),
    showErrorMessage: record('error'),
    registerCustomEditorProvider: () => new StubDisposable(),
    createWebviewPanel: () => {
      throw new Error('the stub does not create webview panels; drive the document directly');
    },
    activeTextEditor: undefined,
  },

  workspace: {
    getConfiguration(section?: string) {
      return {
        get<T>(key: string, fallback?: T): T | undefined {
          const full = section ? `${section}.${key}` : key;
          return (settings.has(full) ? (settings.get(full) as T) : fallback) as T | undefined;
        },
        has: (key: string) => settings.has(section ? `${section}.${key}` : key),
        update: async (key: string, value: unknown) => {
          settings.set(section ? `${section}.${key}` : key, value);
        },
      };
    },
    workspaceFolders: undefined,
    onDidChangeConfiguration: () => new StubDisposable(),
    fs: {
      stat: async () => ({ type: 1, ctime: 0, mtime: 0, size: 0 }),
    },
  },

  commands: {
    registerCommand(name: string, handler: (...args: unknown[]) => unknown) {
      recorded.commands.set(name, handler);
      return new StubDisposable(() => recorded.commands.delete(name));
    },
    executeCommand(command: string, ...args: unknown[]) {
      recorded.executed.push({ command, args });
      return Promise.resolve(undefined);
    },
  },

  ViewColumn: { One: 1, Two: 2, Beside: -2 },
  Uri_basename: basename,
  Uri_dirname: dirname,
};

// ---------------------------------------------------------------------------
// Install the runtime shim.
// ---------------------------------------------------------------------------

type Loader = (request: string, parent: unknown, isMain: boolean) => unknown;

const moduleInternals = Module as unknown as { _load: Loader; __dfvVscodeStubInstalled?: boolean };

if (!moduleInternals.__dfvVscodeStubInstalled) {
  const original = moduleInternals._load;
  moduleInternals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean): unknown {
    if (request === 'vscode') return vscodeStub;
    return original.call(this, request, parent, isMain);
  } as Loader;
  moduleInternals.__dfvVscodeStubInstalled = true;
}

export default vscodeStub;
