import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { isoAfter, startServer, type TestServer } from './helpers.js';

const T0 = '2024-03-01T09:00:00.000Z';

let sequence = 0;
function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}-${Math.random().toString(16).slice(2, 8)}`;
}

describe('fines', () => {
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

  async function newMember(name = 'Debtor') {
    const response = await api.request('POST', '/members', { name, email: `${unique('debtor')}@example.com` });
    assert.equal(response.status, 201);
    return response.body;
  }

  async function borrow(memberId: string, bookId: string, now = T0) {
    return api.request('POST', '/loans', { memberId, bookId }, { 'X-Fake-Now': now });
  }

  async function returnAt(loanId: string, now: string) {
    return api.request('POST', `/loans/${loanId}/return`, undefined, { 'X-Fake-Now': now });
  }

  function account(memberId: string, now = T0) {
    return api.request('GET', `/members/${memberId}/fines`, undefined, { 'X-Fake-Now': now });
  }

  function pay(memberId: string, body?: unknown, now = T0) {
    return api.request('POST', `/members/${memberId}/fines/pay`, body, { 'X-Fake-Now': now });
  }

  /** A member with one loan returned `daysLate` days after its due date. */
  async function lateReturn(daysLate: number) {
    const book = await newBook();
    const member = await newMember();
    const loan = await borrow(member.id, book.id);
    assert.equal(loan.status, 201);
    const returned = await returnAt(loan.body.id, isoAfter(T0, 14 + daysLate));
    assert.equal(returned.status, 200);
    return { member, book, loanId: loan.body.id as string, returned: returned.body };
  }

  it('charges 0.25 per day for a late return and nothing on time', async () => {
    const onTime = await lateReturn(0);
    assert.equal(onTime.returned.fine, null);
    const emptyAccount = await account(onTime.member.id);
    assert.equal(emptyAccount.status, 200);
    assert.deepEqual(emptyAccount.body.fines, []);
    assert.equal(emptyAccount.body.totalOutstanding, 0);

    const late = await lateReturn(3);
    assert.equal(late.returned.fine.amount, 0.75);
    assert.equal(late.returned.fine.outstanding, 0.75);
    assert.equal(late.returned.fine.paid, 0);

    const fines = await account(late.member.id);
    assert.equal(fines.body.fines.length, 1);
    assert.equal(fines.body.fines[0].amount, 0.75);
    assert.equal(fines.body.fines[0].outstanding, 0.75);
    assert.equal(fines.body.fines[0].loanId, late.loanId);
    assert.equal(fines.body.totalCharged, 0.75);
    assert.equal(fines.body.totalOutstanding, 0.75);
    assert.equal(fines.body.limit, 5);
    assert.equal(fines.body.overLimit, false);
  });

  it('charges nothing when the loan is still active and shows accruing fines', async () => {
    const book = await newBook();
    const member = await newMember();
    const loan = await borrow(member.id, book.id);
    assert.equal(loan.status, 201);

    const early = await account(member.id);
    assert.equal(early.body.fines.length, 0);
    assert.equal(early.body.accruing, 0);

    const late = await account(member.id, isoAfter(T0, 18));
    assert.equal(late.body.fines.length, 0, 'fines are charged on return, not while on loan');
    assert.equal(late.body.accruing, 1);
    assert.equal(late.body.totalOutstanding, 0);
  });

  it('pays a fine in full and partially', async () => {
    const { member, loanId } = await lateReturn(8);
    const summary = await account(member.id);
    const fineId = summary.body.fines[0].id as string;

    const partial = await pay(member.id, { amount: 0.5 });
    assert.equal(partial.status, 200);
    assert.equal(partial.body.paidNow, 0.5);
    assert.equal(partial.body.totalOutstanding, 1.5);
    assert.equal(partial.body.fines[0].paid, 0.5);
    assert.equal(partial.body.fines[0].outstanding, 1.5);

    const rest = await pay(member.id, { fineId });
    assert.equal(rest.status, 200);
    assert.equal(rest.body.paidNow, 1.5);
    assert.equal(rest.body.totalOutstanding, 0);
    assert.equal(rest.body.totalPaid, 2);
    assert.equal(rest.body.fines[0].outstanding, 0);

    const again = await pay(member.id);
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'NO_OUTSTANDING_FINES');
    assert.match(again.body.error, new RegExp(member.name));
    assert.equal(loanId.length > 0, true);
  });

  it('refuses to overpay or to pay an unknown fine', async () => {
    const { member, loanId } = await lateReturn(2);

    const tooMuch = await pay(member.id, { amount: 100 });
    assert.equal(tooMuch.status, 400);
    assert.equal(tooMuch.body.code, 'AMOUNT_TOO_LARGE');

    const bad = await pay(member.id, { amount: -1 });
    assert.equal(bad.status, 400);

    const unknown = await pay(member.id, { fineId: 'no-such-fine' });
    assert.equal(unknown.status, 404);

    const notABody = await pay(member.id, { amount: 'lots' });
    assert.equal(notABody.status, 400);

    const fines = await account(member.id);
    assert.equal(fines.body.fines[0].loanId, loanId);
    assert.equal(fines.body.totalOutstanding, 0.5);
  });

  it('blocks borrowing while unpaid fines exceed 5.00', async () => {
    const { member } = await lateReturn(21);
    const other = await newBook();

    const owed = await account(member.id);
    assert.equal(owed.body.totalOutstanding, 5.25);
    assert.equal(owed.body.overLimit, true);

    // The late return also suspended the member for 7 days; wait it out.
    const blocked = await borrow(member.id, other.id, isoAfter(T0, 43));
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, 'FINE_LIMIT');
    assert.match(blocked.body.error, /5\.25/);

    const paid = await pay(member.id, { amount: 0.25 }, isoAfter(T0, 43));
    assert.equal(paid.status, 200);
    assert.equal(paid.body.totalOutstanding, 5);
    assert.equal(paid.body.overLimit, false);

    const allowed = await borrow(member.id, other.id, isoAfter(T0, 43));
    assert.equal(allowed.status, 201, JSON.stringify(allowed.body));
  });

  it('answers 404 for the fines of an unknown member', async () => {
    const missing = await account('no-such-member');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'NOT_FOUND');

    const payment = await pay('no-such-member', { amount: 1 });
    assert.equal(payment.status, 404);
  });

  it('rejects the wrong method on the fines endpoints', async () => {
    const { member } = await lateReturn(1);
    const get = await api.request('GET', `/members/${member.id}/fines/pay`);
    assert.equal(get.status, 405);
    const post = await api.request('POST', `/members/${member.id}/fines`, {});
    assert.equal(post.status, 405);
  });
});
