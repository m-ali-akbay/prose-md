import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { isoAfter, startServer, type TestServer } from './helpers.js';

const T0 = '2024-03-01T09:00:00.000Z';

/** Suffix that keeps records unique across the tests of this file. */
let sequence = 0;
function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}-${Math.random().toString(16).slice(2, 8)}`;
}

describe('loans', () => {
  let api: TestServer;

  before(async () => {
    api = await startServer();
  });

  after(async () => {
    await api.close();
  });

  async function newBook(copies = 1) {
    const response = await api.request('POST', '/books', {
      title: unique('Book'),
      author: 'An Author',
      isbn: unique('isbn'),
      copies,
    });
    assert.equal(response.status, 201);
    return response.body;
  }

  async function newMember(name = 'Reader') {
    const response = await api.request('POST', '/members', { name, email: `${unique('reader')}@example.com` });
    assert.equal(response.status, 201);
    return response.body;
  }

  function borrow(memberId: string, bookId: string, now = T0) {
    return api.request('POST', '/loans', { memberId, bookId }, { 'X-Fake-Now': now });
  }

  function renew(loanId: string, now: string) {
    return api.request('POST', `/loans/${loanId}/renew`, undefined, { 'X-Fake-Now': now });
  }

  function history(memberId: string, now = T0) {
    return api.request('GET', `/members/${memberId}/loans`, undefined, { 'X-Fake-Now': now });
  }

  it('borrows a copy for 14 days', async () => {
    const book = await newBook();
    const member = await newMember();

    const loan = await borrow(member.id, book.id);

    assert.equal(loan.status, 201);
    assert.equal(loan.body.status, 'active');
    assert.equal(loan.body.renewals, 0);
    assert.equal(loan.body.returnedAt, null);
    assert.equal(loan.body.borrowedAt, T0);
    assert.equal(loan.body.dueAt, isoAfter(T0, 14));
    assert.equal(loan.body.book.title, book.title);
    assert.equal(loan.body.member.id, member.id);
  });

  it('fails when no copy is available', async () => {
    const book = await newBook(1);
    const first = await newMember('First');
    const second = await newMember('Second');

    assert.equal((await borrow(first.id, book.id)).status, 201);

    const rejected = await borrow(second.id, book.id);
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.code, 'NO_COPIES');
  });

  it('lets as many members borrow as there are copies', async () => {
    const book = await newBook(2);
    const first = await newMember('First');
    const second = await newMember('Second');
    const third = await newMember('Third');

    assert.equal((await borrow(first.id, book.id)).status, 201);
    assert.equal((await borrow(second.id, book.id)).status, 201);

    const rejected = await borrow(third.id, book.id);
    assert.equal(rejected.body.code, 'NO_COPIES');
  });

  it('refuses to lend to a suspended member but still accepts returns', async () => {
    const book = await newBook();
    const member = await newMember();

    const loan = await borrow(member.id, book.id);
    await api.request('POST', `/members/${member.id}/suspend`, { days: 3 }, { 'X-Fake-Now': T0 });

    const other = await newBook();
    const rejected = await borrow(member.id, other.id);
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.code, 'MEMBER_SUSPENDED');

    const returned = await api.request('POST', `/loans/${loan.body.id}/return`, undefined, {
      'X-Fake-Now': isoAfter(T0, 1),
    });
    assert.equal(returned.status, 200);
    assert.equal(returned.body.status, 'returned');
  });

  it('refuses a sixth active loan', async () => {
    const member = await newMember();
    for (let index = 0; index < 5; index += 1) {
      const book = await newBook();
      assert.equal((await borrow(member.id, book.id)).status, 201);
    }

    const sixth = await borrow(member.id, (await newBook()).id);
    assert.equal(sixth.status, 409);
    assert.equal(sixth.body.code, 'LOAN_LIMIT');

    const memberView = await api.request('GET', `/members/${member.id}`, undefined, { 'X-Fake-Now': T0 });
    assert.equal(memberView.body.activeLoans, 5);
  });

  it('refuses to lend while the member has an overdue loan', async () => {
    const member = await newMember();
    const first = await newBook();
    const second = await newBook();

    assert.equal((await borrow(member.id, first.id)).status, 201);

    // Past the 14 day due date, but not late enough to trigger a suspension.
    const rejected = await borrow(member.id, second.id, isoAfter(T0, 15));
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.code, 'MEMBER_OVERDUE');
  });

  it('returns a copy and refuses a double return', async () => {
    const book = await newBook();
    const member = await newMember();
    const loan = await borrow(member.id, book.id);

    const returned = await api.request('POST', `/loans/${loan.body.id}/return`, undefined, {
      'X-Fake-Now': isoAfter(T0, 2),
    });
    assert.equal(returned.status, 200);
    assert.equal(returned.body.returnedAt, isoAfter(T0, 2));
    assert.equal(returned.body.status, 'returned');
    assert.equal(returned.body.daysOverdue, 0);

    const bookAfter = await api.request('GET', `/books/${book.id}`);
    assert.equal(bookAfter.body.copiesAvailable, 1);

    const again = await api.request('POST', `/loans/${loan.body.id}/return`, undefined, {
      'X-Fake-Now': isoAfter(T0, 3),
    });
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'ALREADY_RETURNED');
  });

  it('suspends a member for 7 days when a return is more than 14 days late', async () => {
    const book = await newBook();
    const member = await newMember();
    const loan = await borrow(member.id, book.id);

    // Due at T0+14d; returning at T0+29d is 15 days late.
    const returnTime = isoAfter(T0, 29);
    const returned = await api.request('POST', `/loans/${loan.body.id}/return`, undefined, {
      'X-Fake-Now': returnTime,
    });
    assert.equal(returned.status, 200);
    assert.equal(returned.body.daysOverdue, 15);

    const memberView = await api.request('GET', `/members/${member.id}`, undefined, { 'X-Fake-Now': returnTime });
    assert.equal(memberView.body.suspended, true);
    assert.equal(memberView.body.suspendedUntil, isoAfter(returnTime, 7));

    const fresh = await newBook();
    const rejected = await borrow(member.id, fresh.id, returnTime);
    assert.equal(rejected.body.code, 'MEMBER_SUSPENDED');

    // Once the suspension has expired the member may borrow again.
    const allowed = await borrow(member.id, fresh.id, isoAfter(returnTime, 8));
    assert.equal(allowed.status, 201);
  });

  it('does not suspend a member who returns exactly 14 days late', async () => {
    const book = await newBook();
    const member = await newMember();
    const loan = await borrow(member.id, book.id);

    const returnTime = isoAfter(T0, 28); // due at T0+14d, so exactly 14 days late
    const returned = await api.request('POST', `/loans/${loan.body.id}/return`, undefined, {
      'X-Fake-Now': returnTime,
    });
    assert.equal(returned.body.daysOverdue, 14);

    const memberView = await api.request('GET', `/members/${member.id}`, undefined, { 'X-Fake-Now': returnTime });
    assert.equal(memberView.body.suspended, false);
  });

  it('renews a loan once for 7 more days', async () => {
    const book = await newBook();
    const member = await newMember();
    const loan = await borrow(member.id, book.id);

    const renewed = await renew(loan.body.id, isoAfter(T0, 3));
    assert.equal(renewed.status, 200);
    assert.equal(renewed.body.renewals, 1);
    assert.equal(renewed.body.dueAt, isoAfter(T0, 21));

    const again = await renew(loan.body.id, isoAfter(T0, 4));
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'ALREADY_RENEWED');
  });

  it('refuses to renew an overdue loan', async () => {
    const book = await newBook();
    const member = await newMember();
    const loan = await borrow(member.id, book.id);

    const rejected = await renew(loan.body.id, isoAfter(T0, 15));
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.code, 'LOAN_OVERDUE');
  });

  it('allows renewing exactly on the due date', async () => {
    const book = await newBook();
    const member = await newMember();
    const loan = await borrow(member.id, book.id);

    const renewed = await renew(loan.body.id, isoAfter(T0, 14));
    assert.equal(renewed.status, 200);
    assert.equal(renewed.body.dueAt, isoAfter(T0, 21));
  });

  it('refuses to renew anything while the member is suspended', async () => {
    const book = await newBook();
    const member = await newMember();
    const loan = await borrow(member.id, book.id);

    await api.request('POST', `/members/${member.id}/suspend`, { days: 3 }, { 'X-Fake-Now': T0 });

    const rejected = await renew(loan.body.id, isoAfter(T0, 1));
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.code, 'MEMBER_SUSPENDED');

    // A refused renewal must not consume the single renewal.
    const afterSuspension = await renew(loan.body.id, isoAfter(T0, 4));
    assert.equal(afterSuspension.status, 200, 'renewing works again once the suspension has expired');
    assert.equal(afterSuspension.body.renewals, 1);
    assert.equal(afterSuspension.body.dueAt, isoAfter(T0, 21));
  });

  it('refuses a renewal when the suspension came from a late return', async () => {
    const member = await newMember();
    const overdueBook = await newBook();
    const otherBook = await newBook();

    const late = await borrow(member.id, overdueBook.id, T0);
    const alsoLate = await borrow(member.id, otherBook.id, isoAfter(T0, 1));

    // Returning 15 days after the due date suspends the member for 7 days.
    const returnTime = isoAfter(T0, 29);
    const returned = await api.request('POST', `/loans/${late.body.id}/return`, undefined, {
      'X-Fake-Now': returnTime,
    });
    assert.equal(returned.status, 200);

    const memberView = await api.request('GET', `/members/${member.id}`, undefined, { 'X-Fake-Now': returnTime });
    assert.equal(memberView.body.suspended, true);

    const rejected = await renew(alsoLate.body.id, returnTime);
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.code, 'MEMBER_SUSPENDED');
  });

  it('lists loans and filters them', async () => {
    const book = await newBook();
    const member = await newMember();
    const loan = await borrow(member.id, book.id);

    const byMember = await api.request('GET', `/loans?memberId=${member.id}`, undefined, { 'X-Fake-Now': T0 });
    assert.equal(byMember.status, 200);
    assert.deepEqual(
      byMember.body.loans.map((entry: { id: string }) => entry.id),
      [loan.body.id],
    );

    const active = await api.request('GET', '/loans?status=active', undefined, { 'X-Fake-Now': T0 });
    assert.ok(active.body.loans.some((entry: { id: string }) => entry.id === loan.body.id));

    const returned = await api.request('GET', '/loans?status=returned', undefined, { 'X-Fake-Now': T0 });
    assert.ok(!returned.body.loans.some((entry: { id: string }) => entry.id === loan.body.id));

    const badStatus = await api.request('GET', '/loans?status=weird', undefined, { 'X-Fake-Now': T0 });
    assert.equal(badStatus.status, 400);
  });

  it('shows the loan history of a member, newest first, active and returned', async () => {
    const member = await newMember();
    const otherMember = await newMember('Other');
    const firstBook = await newBook();
    const secondBook = await newBook();
    const foreignBook = await newBook();

    const older = await borrow(member.id, firstBook.id, T0);
    const newer = await borrow(member.id, secondBook.id, isoAfter(T0, 1));
    const foreign = await borrow(otherMember.id, foreignBook.id, isoAfter(T0, 1));

    const returned = await api.request('POST', `/loans/${older.body.id}/return`, undefined, {
      'X-Fake-Now': isoAfter(T0, 2),
    });
    assert.equal(returned.status, 200);

    const historyNow = isoAfter(T0, 20);
    const response = await history(member.id, historyNow);

    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.loans.map((entry: { id: string }) => entry.id),
      [newer.body.id, older.body.id],
      'the most recently borrowed loan comes first',
    );
    assert.deepEqual(
      response.body.loans.map((entry: { status: string }) => entry.status),
      ['overdue', 'returned'],
    );
    assert.ok(
      !response.body.loans.some((entry: { id: string }) => entry.id === foreign.body.id),
      'loans of other members are not part of the history',
    );

    const entry = response.body.loans.find((candidate: { id: string }) => candidate.id === older.body.id);
    assert.equal(entry.returnedAt, isoAfter(T0, 2));
    assert.equal(entry.book.title, firstBook.title);
    assert.equal(entry.member.id, member.id);
  });

  it('returns an empty history for a member who never borrowed', async () => {
    const member = await newMember();

    const response = await history(member.id);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.loans, []);
  });

  it('rejects the loan history of an unknown member', async () => {
    const response = await history('missing-member');
    assert.equal(response.status, 404);
    assert.equal(response.body.code, 'NOT_FOUND');
  });

  it('lists overdue loans, most overdue first', async () => {
    const member = await newMember();
    const first = await newBook();
    const second = await newBook();

    const older = await borrow(member.id, first.id, T0);
    const newer = await borrow(member.id, second.id, isoAfter(T0, 1));

    const overdue = await api.request('GET', '/loans/overdue', undefined, { 'X-Fake-Now': isoAfter(T0, 20) });
    assert.equal(overdue.status, 200);

    const ids = overdue.body.loans.map((entry: { id: string }) => entry.id);
    assert.ok(ids.includes(older.body.id), 'the older loan should be overdue');
    assert.ok(ids.includes(newer.body.id), 'the newer loan should be overdue');
    assert.ok(ids.indexOf(older.body.id) < ids.indexOf(newer.body.id), 'loans are sorted by due date');

    const entry = overdue.body.loans.find((candidate: { id: string }) => candidate.id === older.body.id);
    assert.equal(entry.status, 'overdue');
    assert.equal(entry.daysOverdue, 6);

    const future = await api.request('GET', '/loans/overdue', undefined, { 'X-Fake-Now': T0 });
    assert.equal(
      future.body.loans.filter((candidate: { memberId: string }) => candidate.memberId === member.id).length,
      0,
      'nothing is overdue before the due dates pass',
    );
  });

  it('rejects loans for unknown members or books', async () => {
    const book = await newBook();
    const member = await newMember();

    const noMember = await borrow('missing-member', book.id);
    assert.equal(noMember.status, 404);
    assert.equal(noMember.body.code, 'NOT_FOUND');

    const noBook = await borrow(member.id, 'missing-book');
    assert.equal(noBook.status, 404);
  });
});
