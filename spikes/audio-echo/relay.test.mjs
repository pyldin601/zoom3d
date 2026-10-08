import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRelay } from './relay.mjs';

class FakeSocket {
  constructor() { this.sent = []; this.closed = null; this.handlers = {}; }
  send(data) { this.sent.push(data); }
  close(code, reason) { this.closed = { code, reason }; }
  on(event, handler) { (this.handlers[event] ??= []).push(handler); }
  emit(event, ...args) { for (const h of this.handlers[event] ?? []) h(...args); }
}

const WAIT = '{"type":"role","role":"wait"}';
const OFFER = '{"type":"role","role":"offer"}';
const JOINED = '{"type":"peer-joined"}';
const LEFT = '{"type":"peer-left"}';

test('first client gets role wait', () => {
  const relay = createRelay();
  const a = new FakeSocket();
  relay.add(a);
  assert.deepEqual(a.sent, [WAIT]);
});

test('second client gets role offer and first gets peer-joined', () => {
  const relay = createRelay();
  const a = new FakeSocket(), b = new FakeSocket();
  relay.add(a); relay.add(b);
  assert.deepEqual(b.sent, [OFFER]);
  assert.deepEqual(a.sent, [WAIT, JOINED]);
});

test('messages are forwarded only to the other client', () => {
  const relay = createRelay();
  const a = new FakeSocket(), b = new FakeSocket();
  relay.add(a); relay.add(b);
  a.emit('message', '{"x":1}');
  assert.equal(b.sent.at(-1), '{"x":1}');
  assert.ok(!a.sent.includes('{"x":1}'));
});

test('third client is closed with 4000 full', () => {
  const relay = createRelay();
  const a = new FakeSocket(), b = new FakeSocket(), c = new FakeSocket();
  relay.add(a); relay.add(b); relay.add(c);
  assert.deepEqual(c.closed, { code: 4000, reason: 'full' });
  assert.deepEqual(c.sent, []);
  assert.equal(relay.size(), 2);
});

test('when a client closes, the survivor gets peer-left and size() is 1', () => {
  const relay = createRelay();
  const a = new FakeSocket(), b = new FakeSocket();
  relay.add(a); relay.add(b);
  b.emit('close');
  assert.equal(a.sent.at(-1), LEFT);
  assert.equal(relay.size(), 1);
});

test('a client joining after a leave gets role offer', () => {
  const relay = createRelay();
  const a = new FakeSocket(), b = new FakeSocket(), c = new FakeSocket();
  relay.add(a); relay.add(b);
  b.emit('close');
  relay.add(c);
  assert.deepEqual(c.sent, [OFFER]);
  assert.equal(a.sent.at(-1), JOINED);
});
