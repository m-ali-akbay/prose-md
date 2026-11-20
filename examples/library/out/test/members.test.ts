import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { startServer, type TestServer } from './helpers.js';

describe('members', () => {
  let api: TestServer;

  before(async () => {
    api = await startServer();
  });

  after(async () => {
    await api.close();
  });

  it('registers a member and returns it', async () => {
    const response = await api.request('POST', '/members', { name: 'Grace Hopper', email: 'Grace@Example.com' });

    assert.equal(response.status, 201);
    assert.equal(response.body.name, 'Grace Hopper');
    assert.equal(response.body.email, 'grace@example.com');
    assert.equal(response.body.suspended, false);
    assert.equal(response.body.suspendedUntil, null);
    assert.equal(response.body.activeLoans, 0);
    assert.ok(typeof response.body.id === 'string');
  });

  it('treats email addresses as case-insensitive and unique', async () => {
    await api.request('POST', '/members', { name: 'Alan Turing', email: 'alan@example.com' });
    const duplicate = await api.request('POST', '/members', { name: 'Alan T.', email: 'ALAN@Example.com' });

    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.code, 'DUPLICATE_EMAIL');

    const members = await api.request('GET', '/members');
    const alans = members.body.members.filter((member: { email: string }) => member.email === 'alan@example.com');
    assert.equal(alans.length, 1);
  });

  it('lists and looks up members by id', async () => {
    const created = await api.request('POST', '/members', { name: 'Katherine Johnson', email: 'katherine@example.com' });

    const listed = await api.request('GET', '/members');
    assert.equal(listed.status, 200);
    const ids = listed.body.members.map((member: { id: string }) => member.id);
    assert.ok(ids.includes(created.body.id));

    const fetched = await api.request('GET', `/members/${created.body.id}`);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.name, 'Katherine Johnson');

    const missing = await api.request('GET', '/members/nope');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'NOT_FOUND');
  });

  it('suspends and reinstates a member', async () => {
    const created = await api.request('POST', '/members', { name: 'Mary Jackson', email: 'mary@example.com' });
    const now = '2024-05-01T00:00:00.000Z';

    const suspended = await api.request('POST', `/members/${created.body.id}/suspend`, {}, { 'X-Fake-Now': now });
    assert.equal(suspended.status, 200);
    assert.equal(suspended.body.suspended, true);
    assert.equal(suspended.body.suspendedUntil, '2024-05-08T00:00:00.000Z');

    const reinstated = await api.request('POST', `/members/${created.body.id}/unsuspend`, undefined, { 'X-Fake-Now': now });
    assert.equal(reinstated.status, 200);
    assert.equal(reinstated.body.suspended, false);
    assert.equal(reinstated.body.suspendedUntil, null);
  });

  it('validates registration input', async () => {
    const badEmail = await api.request('POST', '/members', { name: 'No At', email: 'not-an-email' });
    assert.equal(badEmail.status, 400);
    assert.equal(badEmail.body.code, 'VALIDATION_ERROR');

    const noName = await api.request('POST', '/members', { email: 'someone@example.com' });
    assert.equal(noName.status, 400);
  });
});
