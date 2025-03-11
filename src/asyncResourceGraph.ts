import {
  executionAsyncId as _getExecutionAsyncId,
  executionAsyncResource as _getExecutionAsyncResource,
  createHook,
} from 'node:async_hooks';
import { AsyncResourceKind } from './constants';
import { StackFrame, getStackFrame, promiseWithReject } from './utils';
import { FiberError } from './errors';

export const enum AsyncResourceFlags {
  INIT = 0,
  /** The node's `before` trigger was invoked. Work must have started */
  PRE_EXECUTION = 1 << 0,
  /** The node's `after` trigger was invoked. Work must have been completed */
  POST_EXECUTION = 1 << 1,
  /** The node (which is a promise) has been resolved and triggered subsequent promises */
  RESOLVED = 1 << 2,
  /** The node has been created in a context by a cancelled fiber */
  ABORTED = 1 << 3,

  /** If these flags are set it indicates that the resource is no longer blocking work it's a trigger for */
  FINALIZED = AsyncResourceFlags.POST_EXECUTION | AsyncResourceFlags.RESOLVED,
}

type AsyncResourceObserverFn = (
  event: AsyncResourceFlags,
  node: AsyncResourceNode
) => void;

class AsyncResourceObserver {
  fiberId: number;
  callback: AsyncResourceObserverFn;
  constructor(fiber: AsyncResourceFiber, callback: AsyncResourceObserverFn) {
    this.fiberId = fiber.fiberId;
    this.callback = callback;
  }

  _onInit(node: AsyncResourceNode) {
    this.callback(AsyncResourceFlags.INIT, node);
    if (node.fiberId === this.fiberId) {
      this.observe(node);
    }
  }

  _onBefore(node: AsyncResourceNode) {
    this.callback(AsyncResourceFlags.PRE_EXECUTION, node);
  }

  _onAfter(node: AsyncResourceNode) {
    this.callback(AsyncResourceFlags.POST_EXECUTION, node);
    node.notifyObserver = null;
  }

  _onPromiseResolve(node: AsyncResourceNode) {
    this.callback(AsyncResourceFlags.RESOLVED, node);
    node.notifyObserver = null;
  }

  isObserved(node: AsyncResourceNode): boolean {
    return node.notifyObserver === this;
  }

  observe(node: AsyncResourceNode): void {
    if (node.notifyObserver !== null && node.notifyObserver !== this) {
      throw new TypeError(
        'Only one observer can be attached to a node at a time.\n' +
          `Node (${node.asyncId}) is already being observed`
      );
    }
    node.notifyObserver = this;
  }
}

type RawAsyncResource = object & { [K in typeof fiberRef]?: AsyncResourceNode };

const fiberRef = Symbol('async_resource_node');
const fiberStack: AsyncResourceFiber[] = [];

const getExecutionAsyncResource: () => RawAsyncResource =
  _getExecutionAsyncResource;
const getExecutionAsyncId = _getExecutionAsyncId;

let _fiberIdx = 1;

export class AsyncResourceFiber {
  readonly fiberId = _fiberIdx++;
  readonly root: AsyncResourceNode;

  active = false;
  parent: AsyncResourceFiber | null;
  frame: StackFrame | null;

  constructor(frame: StackFrame | null) {
    // Fibers are created as children of the current fiber,
    // but their root resource will be the current execution context,
    // even if it's deeper into the parent fiber's async graph
    const executionAsyncResource = getExecutionAsyncResource();
    let root = executionAsyncResource[fiberRef];
    if (root === undefined) {
      // WARN: This must imply `!this.parent`
      // If no parent fiber exists, this is the root fiber, and
      // empty state is created for its resource node
      root = new AsyncResourceNode(
        this.fiberId,
        getExecutionAsyncId(),
        null,
        frame
      );
      executionAsyncResource[fiberRef] = root;
    }
    this.root = root;
    this.parent = getFiber();
    this.frame = frame;
  }

  enable() {
    if (!this.active) {
      // Set the current execution context's fiber to be the current fiber
      this.root.fiberId = this.fiberId;
      this.active = true;
      fiberStack.push(this);
      asyncResourceGraphHook.enable();
    }
    return this;
  }

  disable() {
    fiberStack.splice(fiberStack.indexOf(this), 1);
    if (!fiberStack.length) asyncResourceGraphHook.disable();
    // Reset the context's fiber. This must use the stack since fibers
    // may be created out of order and `this.parent` may not be
    // the same as the stack's fiber
    this.root.fiberId = getFiber()?.fiberId || 0;
    this.active = false;
    return this;
  }

  get parentFiberIds(): readonly number[] {
    const parentFiberIds: number[] = [];
    let fiber: AsyncResourceFiber | null = this;
    while ((fiber = fiber.parent) !== null) parentFiberIds.push(fiber.fiberId);
    return parentFiberIds;
  }

  /** Returns amount of pending tasks in the fiber */
  get pending() {
    const countExecutionTargets = (node: AsyncResourceNode) => {
      let count = 0;
      // To count all pending tasks, we check all resources that
      // have been created on the fiber recursively and count all
      // non-finalized ones
      for (const target of node.executionTargets.values()) {
        if (target.fiberId === this.fiberId) {
          count += countExecutionTargets(target);
          count += target.flags & AsyncResourceFlags.FINALIZED ? 0 : 1;
        }
      }
      return count;
    };
    // Pending tasks may be counted excluding the top-level resource,
    // as it presumably will still be in progress, but shouldn't be
    // considered to be blocking.
    return countExecutionTargets(this.root);
  }

  get executionTargets(): AsyncResourceNode[] {
    return [...this.root.executionTargets.values()].filter(node => {
      return node.fiberId === this.fiberId;
    });
  }

  toString() {
    return `[Fiber: ${this.fiberId}]`;
  }
}

/** Descriptors for an async resource (akin to IO tasks) */
export class AsyncResourceNode {
  asyncId: number;
  fiberId: number;
  type: AsyncResourceKind | null;
  active: boolean;

  /** If available, a stacktrace frame pointing to the resource's initialization */
  frame: StackFrame | null;

  /** An execution context's descriptor this async resource was created in */
  executionOrigin: AsyncResourceNode | null;
  /** An async resource's descriptor which will, upon completion, trigger this async resource
   * @remarks
   * This will be identical to `executionOrigin` if the resource was triggerd synchronously
   */
  triggerOrigin: AsyncResourceNode | null;

  /** Async resources that this resource has created (sub-tasks) */
  executionTargets: Map<number, AsyncResourceNode>;
  /** Async resources that this resource will trigger upon completion (follow-up tasks) */
  triggerTargets: Map<number, AsyncResourceNode>;

  /** Descriptions and completion state of this node */
  flags: AsyncResourceFlags;

  /** Observer that should be notified about changes */
  notifyObserver: AsyncResourceObserver | null;

  constructor(
    fiberId: number,
    asyncId: number,
    type: string | null,
    frame: StackFrame | null
  ) {
    this.active = true;
    this.asyncId = asyncId;
    this.fiberId = fiberId;
    this.type = type as AsyncResourceKind;
    this.frame = frame;
    this.executionOrigin = null;
    this.triggerOrigin = null;
    this.executionTargets = new Map();
    this.triggerTargets = new Map();
    this.flags = AsyncResourceFlags.INIT;
    this.notifyObserver = null;
  }

  _onExecute(
    asyncId: number,
    type: string,
    triggerAsyncId: number,
    resource: RawAsyncResource
  ) {
    if (!this.active) {
      return;
    }
    // This method is called on an execution context's descriptor that created a new async resource.
    // Hence, we create a new child async resource here
    const frame = getStackFrame(1);
    const node = new AsyncResourceNode(this.fiberId, asyncId, type, frame);
    node.executionOrigin = this;
    resource[fiberRef] = node;
    this.executionTargets.set(asyncId, node);
    const triggerNode =
      asyncId !== triggerAsyncId
        ? getAsyncResourceNode(triggerAsyncId)
        : undefined;
    if (triggerNode) {
      node.triggerOrigin = triggerNode;
      triggerNode.triggerTargets.set(asyncId, node);
    }
    if (this.notifyObserver) {
      this.notifyObserver._onInit(node);
    }
  }

  _onBefore() {
    this.flags |= AsyncResourceFlags.PRE_EXECUTION;
    if (this.active && this.notifyObserver) {
      this.notifyObserver._onBefore(this);
    }
  }

  _onAfter() {
    this.flags |= AsyncResourceFlags.POST_EXECUTION;
    if (this.active && this.notifyObserver) {
      this.notifyObserver._onAfter(this);
    }
  }

  _onPromiseResolve() {
    this.flags |= AsyncResourceFlags.RESOLVED;
    if (this.active && this.notifyObserver) {
      this.notifyObserver._onPromiseResolve(this);
    }
  }

  toString() {
    const name = this.type
      ? `${this.type}(${this.asyncId})`
      : `Fiber: ${this.fiberId}`;
    return `[async ${name}]`;
  }
}

const taintAsyncResourceGraph = (
  node: AsyncResourceNode,
  mask: AsyncResourceFlags,
  flags: AsyncResourceFlags
) => {
  if ((node.flags & mask & flags) === 0) {
    node.flags |= flags;
    for (const target of node.executionTargets.values())
      taintAsyncResourceGraph(target, mask, flags);
    for (const target of node.triggerTargets.values())
      taintAsyncResourceGraph(target, mask, flags);
  }
};

const getAsyncResourceNode = (
  asyncId: number
): AsyncResourceNode | undefined => {
  let executionNode = getExecutionAsyncResource()[fiberRef] ?? null;
  if (executionNode) {
    // The `asyncResourceGraphHook`'s callbacks execute inside the fiber's execution context stack.
    // This means we can find any node by checking all nodes in the current and any parent
    // execution contexts.
    let node: AsyncResourceNode | undefined;
    do {
      if (executionNode.asyncId === asyncId) return executionNode;
      if ((node = executionNode.executionTargets.get(asyncId))) return node;
    } while ((executionNode = executionNode.executionOrigin));
  }
};

let _asyncResourceGraphHookActive = false;

const asyncResourceGraphHook = createHook({
  init(
    asyncId: number,
    type: string,
    triggerAsyncId: number,
    resource: RawAsyncResource
  ) {
    if (!_asyncResourceGraphHookActive) {
      try {
        _asyncResourceGraphHookActive = true;
        const executionNode = getExecutionAsyncResource()[fiberRef];
        executionNode?._onExecute(asyncId, type, triggerAsyncId, resource);
      } finally {
        _asyncResourceGraphHookActive = false;
      }
    }
  },
  before(asyncId: number) {
    try {
      _asyncResourceGraphHookActive = true;
      getAsyncResourceNode(asyncId)?._onBefore();
    } finally {
      _asyncResourceGraphHookActive = false;
    }
  },
  after(asyncId: number) {
    try {
      _asyncResourceGraphHookActive = true;
      getAsyncResourceNode(asyncId)?._onAfter();
    } finally {
      _asyncResourceGraphHookActive = false;
    }
  },
  promiseResolve(asyncId: number) {
    try {
      _asyncResourceGraphHookActive = true;
      getAsyncResourceNode(asyncId)?._onPromiseResolve();
    } finally {
      _asyncResourceGraphHookActive = false;
    }
  },
  // NOTE: While it's nice for cleanups we leave out the `destroy`
  // hook since it has performance implications according to the docs
});

function fiberWatchdog<T>(
  fiber: AsyncResourceFiber,
  params: FiberParams,
  promise: Promise<T>
): Promise<T> {
  try {
    let watchdogImmediate: NodeJS.Immediate | void;
    fiber.root.active = false;

    const { abort } = params;
    const { parentFiberIds } = fiber;

    const pendingExecutionTargets = new Set<AsyncResourceNode>();
    const watchdogResult = promiseWithReject(promise, () => {
      if (watchdogImmediate)
        watchdogImmediate = clearImmediate(watchdogImmediate);
    });

    function lastExecutionTarget(): AsyncResourceNode {
      if (pendingExecutionTargets.size) {
        const targets = [...pendingExecutionTargets.values()];
        return targets[targets.length - 1];
      } else {
        const targets = fiber.executionTargets;
        return targets[targets.length - 1] || fiber.root;
      }
    }

    function assertFiberAbort(node: AsyncResourceNode) {
      if (node.flags & AsyncResourceFlags.ABORTED) {
        assertFiberError(new FiberError('FIBER_ABORTED', fiber, node));
      } else if (
        node.triggerOrigin &&
        node.triggerOrigin.flags & AsyncResourceFlags.ABORTED
      ) {
        if (node.triggerOrigin.fiberId === fiber.fiberId) {
          assertFiberError(
            new FiberError('FIBER_ABORTED', fiber, node.triggerOrigin)
          );
        } else {
          assertFiberError(
            new FiberError('FOREIGN_ASYNC_ABORTED', fiber, node.triggerOrigin)
          );
        }
      } else if (abort?.aborted) {
        assertFiberError(abort.reason);
        if (_asyncResourceGraphHookActive) abort.throwIfAborted();
      }
    }

    function assertFiberError(error: Error) {
      watchdogResult.reject(error);
      if (_asyncResourceGraphHookActive) throw error;
    }

    function assertFiberOwnership(node: AsyncResourceNode) {
      const { triggerOrigin } = node;
      if (node.fiberId !== fiber.fiberId || !triggerOrigin) {
        // We only check triggers for nodes owned by the current fiber
      } else if (triggerOrigin === fiber.root) {
        // Immediately invoked async IO on the fiber root are ignored
      } else if (triggerOrigin.fiberId === node.fiberId) {
        // If the trigger is a node in the same fiber, this is allowed
      } else {
        const isParentFiberTrigger = parentFiberIds.includes(
          triggerOrigin.fiberId
        );
        if (!isParentFiberTrigger) {
          assertFiberError(
            new FiberError('FOREIGN_ASYNC_TRIGGER', fiber, node)
          );
        } else {
          // TODO: Selectively allow resolved promises
          assertFiberError(new FiberError('PARENT_ASYNC_TRIGGER', fiber, node));
        }
      }
    }

    function stallWatchdog() {
      watchdogImmediate = undefined;
      if (abort?.aborted) {
        return;
      }
      let hasAsyncIO = false;
      for (const asyncNode of pendingExecutionTargets) {
        if (
          (asyncNode.flags & AsyncResourceFlags.FINALIZED) === 0 &&
          asyncNode.type !== 'PROMISE'
        ) {
          hasAsyncIO = true;
          break;
        }
      }
      if (!hasAsyncIO) {
        watchdogResult.reject(
          new FiberError('FIBER_STALL', fiber, lastExecutionTarget())
        );
      }
    }

    const scheduleCheck = () =>
      watchdogImmediate || (watchdogImmediate = setImmediate(stallWatchdog));
    watchdogImmediate = setImmediate(stallWatchdog);

    abort?.addEventListener('abort', () => {
      taintAsyncResourceGraph(
        fiber.root,
        AsyncResourceFlags.FINALIZED,
        AsyncResourceFlags.ABORTED
      );
    });

    const observer = new AsyncResourceObserver(fiber, (event, node) => {
      scheduleCheck();
      switch (event) {
        case AsyncResourceFlags.INIT:
          assertFiberOwnership(node);
          assertFiberAbort(node);
          pendingExecutionTargets.add(node);
          return;
        case AsyncResourceFlags.POST_EXECUTION:
          pendingExecutionTargets.delete(node);
          return;
        case AsyncResourceFlags.RESOLVED:
          assertFiberAbort(node);
          pendingExecutionTargets.delete(node);
          return;
        default:
          return;
      }
    });

    const stack: AsyncResourceNode[] = [];
    for (const target of fiber.root.executionTargets.values()) {
      if (target.fiberId === fiber.fiberId) {
        stack.push(target);
        observer.observe(target);
        if ((target.flags & AsyncResourceFlags.FINALIZED) === 0) {
          assertFiberOwnership(target);
          pendingExecutionTargets.add(target);
        }
      }
    }
    let pointer: AsyncResourceNode | undefined;
    while ((pointer = stack.pop())) {
      for (const target of pointer.executionTargets.values()) {
        if (!observer.isObserved(target)) {
          stack.push(target);
          observer.observe(target);
          if ((target.flags & AsyncResourceFlags.FINALIZED) === 0) {
            assertFiberOwnership(target);
            pendingExecutionTargets.add(target);
          }
        }
      }
    }

    return watchdogResult.promise;
  } finally {
    fiber.root.active = false;
  }
}

/** Enable async resource graph tracking and initialize root fiber if needed.
 * @remarks
 * Call this as early as async resources are created that other fibers depend
 * on. No async resources outside of the root fiber will be tracked!
 */
export function enable(): AsyncResourceFiber {
  return getFiber() || new AsyncResourceFiber(getStackFrame(0)).enable();
}

/** Disable top-level fiber
 * @remarks
 * If a root fiber has been created with `enable()`, calling this function
 * allows all fiber data to be garbage collected.
 */
export function disable(): AsyncResourceFiber | null {
  return getFiber()?.disable() || null;
}

/** Get currently active fiber */
export function getFiber(): AsyncResourceFiber | null {
  for (let idx = fiberStack.length - 1; idx >= 0; idx--)
    if (fiberStack[idx].active) return fiberStack[idx];
  return null;
}

/** Returns an arbitrary async resource's descriptor
 * @remarks
 * WARN: This will only work for async resource objects that have been
 * created in a fiber.
 */
export function getFiberNode(resource: object): AsyncResourceNode | undefined {
  return resource[fiberRef];
}

export interface FiberParams {
  abort?: AbortSignal;
}

/** Create a fiber and execute it, returning both the result of `fn` and its fiber
 * @remarks
 * While this function returns synchronously, it will track all async resources
 * that the passed function has created.
 */
export function fiber<T>(
  fn: () => Promise<T>,
  params: FiberParams = {}
): { return: Promise<T>; fiber: AsyncResourceFiber } {
  const fiber = new AsyncResourceFiber(getStackFrame(0));
  try {
    fiber.enable();
    return { return: fiberWatchdog(fiber, params, fn()), fiber };
  } finally {
    fiber.disable();
  }
}
