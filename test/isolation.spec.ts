import { beforeAll, afterAll, it, expect } from 'vitest';
import { enable, disable, fiber } from '../src/index';

beforeAll(() => {
  enable();
});

afterAll(() => {
  disable();
});

it('prevents async resources from being shared into a fiber (sync)', async () => {
  const shared = new Promise(resolve => {
    setImmediate(resolve);
  });

  await expect(() => {
    return fiber(async () => {
      await shared;
    }).return;
  }).rejects.toMatchObject({
    code: 'PARENT_ASYNC_TRIGGER',
  });
});

it('prevents async resources from being shared into a fiber (async)', async () => {
  const shared = new Promise(resolve => {
    setImmediate(resolve);
  });

  await expect(() => {
    return fiber(async () => {
      await Promise.resolve();
      await shared;
    }).return;
  }).rejects.toMatchObject({
    code: 'PARENT_ASYNC_TRIGGER',
  });
});

it('prevents async resources from being shared across fibers (sync)', async () => {
  let shared: Promise<unknown>;

  fiber(async () => {
    shared = new Promise(resolve => {
      setImmediate(resolve);
    });
  });

  await expect(() => {
    return fiber(async () => {
      await shared;
    }).return;
  }).rejects.toMatchObject({
    code: 'FOREIGN_ASYNC_TRIGGER',
  });
});

it('prevents async resources from being shared across fibers (async)', async () => {
  let shared: Promise<unknown>;

  fiber(async () => {
    shared = new Promise(resolve => {
      setImmediate(resolve);
    });
  });

  await expect(() => {
    return fiber(async () => {
      await Promise.resolve();
      await shared;
    }).return;
  }).rejects.toMatchObject({
    code: 'FOREIGN_ASYNC_TRIGGER',
  });
});

it('prevents `new Promise` stalls from waiting indefinitely (sync)', async () => {
  await expect(() => {
    return fiber(async () => {
      await new Promise(() => {
        /*noop*/
      });
    }).return;
  }).rejects.toMatchObject({
    code: 'FIBER_STALL',
  });
});

it('prevents `new Promise` stalls from waiting indefinitely (async)', async () => {
  await expect(() => {
    return fiber(async () => {
      await Promise.resolve();
      await new Promise(() => {
        /*noop*/
      });
    }).return;
  }).rejects.toMatchObject({
    code: 'FIBER_STALL',
  });
});
