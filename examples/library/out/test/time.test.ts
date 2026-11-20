import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { isoAfter, startServer, type TestServer } from './helpers.js';

const T0 = '2024-03-01T09:00:00.000Z';

describe('X-Fake-Now time travel', () => {
  let api: TestServer;

  before(async () => {
    api = await startServer();
  });

  after(async () => {
    await api.close();
  });

  it('rejects an unparseable X-Fake-Now header', async () => {
    const response = await api.request('GET', '/books', undefined, { 'X-Fake-Now': 'not-a-date' });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'INVALID_FAKE_NOW');
    assert.match(response.body.error, /X-Fake-Now/);
  });

  it('accepts a plain date as well as a full timestamp', async () => {
    const book = await api.request('POST', '/books', { title: 'Time', author: 'A', isbn: 'time-1' });
    const member = await api.request('POST', '/members', { name: 'Susan Calvin', email: 'susan@example.com' });

    const loan = await api.request(
      'POST',
      '/loans',
      { memberId: member.body.id, bookId: book.body.id },
      { 'X-Fake-Now': '2024-03-01' },
    );

    assert.equal(loan.status, 201);
    assert.equal(loan.body.borrowedAt, '2024-03-01T00:00:00.000Z');
    assert.equal(loan.body.dueAt, '2024-03-15T00:00:00.000Z');
  });

  it('uses the wall clock when no header is sent', async () => {
    const book = await api.request('POST', '/books', { title: 'Real Time', author: 'B', isbn: 'time-2' });
    const member = await api.request('POST', '/members', { name: 'Hari Seldon', email: 'hari@example.com' });

    const before = Date.now();
    const loan = await api.request('POST', '/loans', { memberId: member.body.id, bookId: book.body.id });
    const after = Date.now();

    assert.equal(loan.status, 201);
    const due = new Date(loan.body.dueAt).getTime();
    const fourteenDays = 14 * 24 * 60 * 60 * 1000;
    assert.ok(due >= before + fourteenDays, 'due date should be 14 days after the request');
    assert.ok(due <= after + fourteenDays + 1000, 'due date should not be later than 14 days plus a second');
  });

  it('moves loans from active to overdue as time passes', async () => {
    const book = await api.request('POST', '/books', { title: 'Slow Time', author: 'C', isbn: 'time-3' });
    const member = await api.request('POST', '/members', { name: 'Dors Venabili', email: 'dors@example.com' });
    const loan = await api.request(
      'POST',
      '/loans',
      { memberId: member.body.id, bookId: book.body.id },
      { 'X-Fake-Now': T0 },
    );

    const onTime = await api.request('GET', `/loans?memberId=${member.body.id}`, undefined, { 'X-Fake-Now': isoAfter(T0, 10) });
    assert.equal(onTime.body.loans[0].status, 'active');
    assert.equal(onTime.body.loans[0].daysOverdue, 0);

    const overdue = await api.request('GET', `/loans?memberId=${member.body.id}`, undefined, {
      'X-Fake-Now': isoAfter(T0, 16),
    });
    assert.equal(overdue.body.loans[0].status, 'overdue');
    assert.equal(overdue.body.loans[0].daysOverdue, 2);
    assert.equal(overdue.body.loans[0].id, loan.body.id);
  });

  it('expires a suspension automatically', async () => {
    const book = await api.request('POST', '/books', { title: 'Suspended', author: 'D', isbn: 'time-4' });
    const other = await api.request('POST', '/books', { title: 'Other', author: 'D', isbn: 'time-5' });
    const member = await api.request('POST', '/members', { name: 'R. Daneel', email: 'daneel@example.com' });

    const loan = await api.request(
      'POST',
      '/loans',
      { memberId: member.body.id, bookId: book.body.id },
      { 'X-Fake-Now': T0 },
    );

    // 15 days after the due date -> 7 day suspension starting at the return time.
    const returnTime = isoAfter(T0, 29);
    await api.request('POST', `/loans/${loan.body.id}/return`, undefined, { 'X-Fake-Now': returnTime });

    const duringSuspension = await api.request(
      'POST',
      '/loans',
      { memberId: member.body.id, bookId: other.body.id },
      { 'X-Fake-Now': isoAfter(returnTime, 3) },
    );
    assert.equal(duringSuspension.status, 409);
    assert.equal(duringSuspension.body.code, 'MEMBER_SUSPENDED');

    const afterSuspension = await api.request(
      'POST',
      '/loans',
      { memberId: member.body.id, bookId: other.body.id },
      { 'X-Fake-Now': isoAfter(returnTime, 7) },
    );
    assert.equal(afterSuspension.status, 201);
  });

  it('exposes a health endpoint', async () => {
    const response = await api.request('GET', '/health');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { status: 'ok' });
  });

  it('answers 404 for unknown resources and 405 for the wrong method', async () => {
    const unknown = await api.request('GET', '/nothing-here');
    assert.equal(unknown.status, 404);

    const wrongMethod = await api.request('PUT', '/books');
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.body.code, 'METHOD_NOT_ALLOWED');
  });
});
