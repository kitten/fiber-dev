import { inspect } from 'node:util';
import { writeSync } from 'node:fs';

export const printf = (...args: unknown[]) => {
  writeSync(
    process.stderr.fd,
    args
      .map(arg => {
        return typeof arg === 'object' && arg ? inspect(arg) : `${arg}`;
      })
      .join(' ') + '\n'
  );
};

const MAX_STACK_DEPTH = 10;

const isNodeSite = (site: NodeJS.CallSite) =>
  !!site.getFileName()?.startsWith('node:');
const isNodeInternalSite = (site: NodeJS.CallSite) =>
  !!site.getFileName()?.startsWith('node:internal/');

export class StackFrame {
  isToplevel: boolean;
  isNative: boolean;
  isConstructor: boolean;
  typeName: string | null;
  functionName: string | null;
  methodName: string | null;
  fileName: string | null;
  lineNumber: number | null;
  columnNumber: number | null;
  constructor(stack: NodeJS.CallSite[], offset: number) {
    let idx = offset;
    let site: NodeJS.CallSite | undefined = stack[idx];
    while (idx < stack.length && isNodeSite((site = stack[idx]))) idx++;
    this.fileName = site.getFileName() || null;
    this.lineNumber = site.getLineNumber();
    this.columnNumber = site.getColumnNumber();
    this.functionName = site.getFunctionName();
    do {
      this.isToplevel = site.isToplevel();
      this.isNative = site.isNative();
      this.isConstructor = site.isConstructor();
      this.typeName = site.getTypeName();
      this.functionName = site.getFunctionName();
      this.methodName = site.getMethodName();
    } while (
      idx > offset &&
      this.functionName === null &&
      this.methodName === null &&
      !isNodeInternalSite((site = stack[--idx]))
    );
  }
  toString() {
    const prefix = this.isConstructor ? 'new ' : '';
    const namePrefix =
      this.typeName !== null && this.typeName !== 'global'
        ? `${this.typeName}.`
        : '';
    const name = `${namePrefix}${this.functionName || this.methodName || '<anonymous>'}`;
    let location = this.fileName || '<anonymous>';
    if (this.lineNumber != null) location += `:${this.lineNumber}`;
    if (this.columnNumber != null) location += `:${this.columnNumber}`;
    return `${prefix}${name}${!!name ? ' (' : ''}${location}${!!name ? ')' : ''}`;
  }
}

export function getStackFrame(offset = 0): StackFrame | null {
  const originalStackFormatter = Error.prepareStackTrace;
  const originalStackTraceLimit = Error.stackTraceLimit;
  try {
    Error.stackTraceLimit = MAX_STACK_DEPTH + offset;
    Error.prepareStackTrace = (_err, stack) =>
      new StackFrame(stack, 2 + offset);
    return new Error().stack as any;
  } finally {
    Error.prepareStackTrace = originalStackFormatter;
    Error.stackTraceLimit = originalStackTraceLimit;
  }
}

export interface PromiseWithReject<T> {
  promise: Promise<T>;
  reject(reason?: any): void;
}

export function promiseWithReject<T>(
  promise: Promise<T>,
  onSettled: () => void
): PromiseWithReject<T> {
  let reject: PromiseWithReject<T>['reject'];
  return {
    promise: new Promise<T>((resolve, _reject) => {
      promise.then(
        result => {
          resolve(result);
          onSettled();
        },
        reason => {
          _reject(reason);
          onSettled();
        }
      );
      reject = _reject;
    }),
    reject: reject!,
  };
}
