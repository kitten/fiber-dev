import type {
  AsyncResourceFiber,
  AsyncResourceNode,
} from './asyncResourceGraph';

export type FiberErrorCode =
  | 'FOREIGN_ASYNC_TRIGGER'
  | 'PARENT_ASYNC_TRIGGER'
  | 'FOREIGN_ASYNC_ABORTED'
  | 'FIBER_ABORTED'
  | 'FIBER_STALL';

const codeToMessage = (
  code: FiberErrorCode,
  fiber: AsyncResourceFiber,
  node: AsyncResourceNode
): string => {
  switch (code) {
    case 'FOREIGN_ASYNC_TRIGGER':
      return (
        `${fiber} tried to create ${node} which will be triggered by async IO from a different fiber.\n` +
        'Fibers are isolated and may only create and reference async resources they have created themselves.'
      );
    case 'PARENT_ASYNC_TRIGGER':
      return (
        `${fiber} tried to create ${node} which will be triggered by async IO of this fiber's parent context.\n` +
        'Fibers are isolated and may only create and reference async resources they have created themselves.'
      );
    case 'FOREIGN_ASYNC_ABORTED':
      return (
        `${fiber} used ${node} from another fiber which was aborted and can never resolve.\n` +
        'Fibers may not share async resources, and may accidentally prevent each other from resolving if they do.'
      );
    case 'FIBER_ABORTED':
      return (
        `${fiber}'s ${node} was aborted and will never resolve.\n` +
        "If you see this message, you're observing an internal forceful cancellation of a fiber and this error is expected."
      );
    case 'FIBER_STALL':
      return (
        `${fiber} has finished all of its work but won't resolve and pass control back to the parent fiber.\n` +
        'This usally happens if a Promise is unresolved or if its async IO has been cancelled without a callback being handled.\n' +
        `${node} is the last async resource the fiber got stuck on.`
      );
  }
};

const traceNode = (
  node: AsyncResourceNode,
  fiber: AsyncResourceFiber,
  depth = 1
): string => {
  let trace = `${node}`;
  let origin: AsyncResourceNode | null = node;
  for (let idx = 1; origin && origin !== fiber.root && idx <= depth; idx++) {
    if (origin.frame) trace += `\n    at ${origin.frame}`;
    origin = origin.executionOrigin;
  }
  return trace;
};

export class FiberError extends Error {
  static stackTraceLimit = 10;

  readonly fiber: AsyncResourceFiber;
  readonly node: AsyncResourceNode;
  readonly code: FiberErrorCode;

  constructor(
    code: FiberErrorCode,
    fiber: AsyncResourceFiber,
    node: AsyncResourceNode
  ) {
    super(codeToMessage(code, fiber, node));
    this.fiber = fiber;
    this.node = node;
    this.code = code;
  }

  get trace(): string {
    let trace = traceNode(this.node, this.fiber);
    if (this.node.triggerOrigin)
      trace += `\ntriggered by ${traceNode(this.node.triggerOrigin, this.fiber, FiberError.stackTraceLimit)}`;
    if (this.node.executionOrigin)
      trace += `\nexecuted in ${traceNode(this.node.executionOrigin, this.fiber, FiberError.stackTraceLimit)}`;
    return trace;
  }

  toString() {
    return `${this.message.trim()}\n\n${this.trace}`;
  }

  toJSON() {
    return this.toString();
  }
}
