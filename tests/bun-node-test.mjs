import nodeTest from 'node:test';

let test = nodeTest;

if (typeof Bun !== 'undefined') {
  const { test: bunTest } = await import('bun:test');
  const context = () => ({
    test: async (_name, callback) => callback(context()),
    skip: () => {}
  });
  test = (name, callback, options) => bunTest(name, () => callback(context()), options);
}

export default test;
