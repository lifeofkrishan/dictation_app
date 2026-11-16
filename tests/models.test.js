import test from 'node:test';
import assert from 'node:assert/strict';
import { MODELS, pickEngine, saferChoice, isAppleWebKit } from '../js/models.js';

const iphone = { vendor: 'Apple Computer, Inc.', gpu: {}, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1' };
const oldIphone = { vendor: 'Apple Computer, Inc.', userAgent: iphone.userAgent.replace('26.1', '17.5') };
const chrome = { vendor: 'Google Inc.', gpu: {}, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' };
const chromeNoGpu = { vendor: 'Google Inc.', userAgent: chrome.userAgent };

test('Safari is recognised, Chrome is not', () => {
  assert.equal(isAppleWebKit(iphone), true);
  assert.equal(isAppleWebKit(chrome), false);
});

test('automatic: processor on iPhone, graphics chip elsewhere when available', () => {
  assert.equal(pickEngine('auto', iphone), 'cpu');
  assert.equal(pickEngine('auto', chrome), 'webgpu');
  assert.equal(pickEngine('auto', chromeNoGpu), 'cpu');
});

test('an explicit choice is respected, unless the browser has no WebGPU at all', () => {
  assert.equal(pickEngine('webgpu', iphone), 'webgpu');
  assert.equal(pickEngine('cpu', chrome), 'cpu');
  assert.equal(pickEngine('webgpu', oldIphone), 'cpu');
});

test('after a crash the next choice is always lighter, and eventually there is none', () => {
  assert.deepEqual(saferChoice('base', 'webgpu'), { model: 'base', engine: 'cpu' });
  assert.deepEqual(saferChoice('small', 'cpu'), { model: 'base', engine: 'cpu' });
  assert.deepEqual(saferChoice('base', 'cpu'), { model: 'tiny', engine: 'cpu' });
  assert.equal(saferChoice('tiny', 'cpu'), null);
  // following the chain from the heaviest option always terminates
  let step = { model: 'small', engine: 'webgpu' };
  let steps = 0;
  while ((step = saferChoice(step.model, step.engine))) assert.ok(++steps < 10);
  assert.equal(steps, 3);
});

test('every model defines both engines', () => {
  for (const model of Object.values(MODELS)) {
    assert.ok(model.cpu.megabytes > 0 && model.webgpu.megabytes > 0);
    assert.ok(model.cpu.megabytes < model.webgpu.megabytes);
  }
});
