import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { startServer, type TestServer } from './helpers.js';

describe('books', () => {
  let api: TestServer;

  before(async () => {
    api = await startServer();
  });

  after(async () => {
    await api.close();
  });

  it('adds a book and reports availability', async () => {
    const response = await api.request('POST', '/books', {
      title: 'Dune',
      author: 'Frank Herbert',
      isbn: '9780441013593',
      copies: 3,
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.title, 'Dune');
    assert.equal(response.body.author, 'Frank Herbert');
    assert.equal(response.body.isbn, '9780441013593');
    assert.equal(response.body.copiesOwned, 3);
    assert.equal(response.body.copiesOnLoan, 0);
    assert.equal(response.body.copiesAvailable, 3);
    assert.ok(typeof response.body.id === 'string');
  });

  it('defaults to a single copy', async () => {
    const response = await api.request('POST', '/books', {
      title: 'Solaris',
      author: 'Stanisław Lem',
      isbn: '9780156027601',
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.copiesOwned, 1);
  });

  it('increases copies instead of duplicating an existing ISBN', async () => {
    const first = await api.request('POST', '/books', {
      title: 'Neuromancer',
      author: 'William Gibson',
      isbn: '978-0-441-56956-4',
      copies: 2,
    });
    assert.equal(first.status, 201);

    const second = await api.request('POST', '/books', {
      title: 'Neuromancer',
      author: 'William Gibson',
      isbn: '9780441569564',
      copies: 3,
    });

    assert.equal(second.status, 200);
    assert.equal(second.body.id, first.body.id);
    assert.equal(second.body.copiesOwned, 5);

    const listed = await api.request('GET', '/books?isbn=9780441569564');
    assert.equal(listed.body.books.length, 1);
    assert.equal(listed.body.books[0].copiesOwned, 5);
  });

  it('lists every book', async () => {
    const response = await api.request('GET', '/books');
    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.body.books));
    const titles = response.body.books.map((book: { title: string }) => book.title);
    assert.ok(titles.includes('Dune'));
    assert.ok(titles.includes('Solaris'));
  });

  it('searches by title or author, case-insensitively and partially', async () => {
    await api.request('POST', '/books', { title: 'The Left Hand of Darkness', author: 'Ursula K. Le Guin', isbn: '9780441478125' });

    const byTitle = await api.request('GET', '/books?q=left%20hand');
    assert.deepEqual(
      byTitle.body.books.map((book: { title: string }) => book.title),
      ['The Left Hand of Darkness'],
    );

    const byAuthor = await api.request('GET', '/books?q=LE%20GUIN');
    assert.deepEqual(
      byAuthor.body.books.map((book: { title: string }) => book.title),
      ['The Left Hand of Darkness'],
    );

    const none = await api.request('GET', '/books?q=no-such-title');
    assert.deepEqual(none.body.books, []);
  });

  it('fetches a single book by id and 404s for unknown ids', async () => {
    const created = await api.request('POST', '/books', {
      title: 'Hyperion',
      author: 'Dan Simmons',
      isbn: '9780553283686',
    });

    const fetched = await api.request('GET', `/books/${created.body.id}`);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.title, 'Hyperion');

    const missing = await api.request('GET', '/books/does-not-exist');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'NOT_FOUND');
  });

  it('tracks copies on loan and refuses to remove a book that is on loan', async () => {
    const book = await api.request('POST', '/books', {
      title: 'The Dispossessed',
      author: 'Ursula K. Le Guin',
      isbn: '9780060512750',
    });
    const member = await api.request('POST', '/members', { name: 'Ada Lovelace', email: 'ada@example.com' });

    const loan = await api.request('POST', '/loans', {
      memberId: member.body.id,
      bookId: book.body.id,
    });
    assert.equal(loan.status, 201);

    const afterLoan = await api.request('GET', `/books/${book.body.id}`);
    assert.equal(afterLoan.body.copiesOnLoan, 1);
    assert.equal(afterLoan.body.copiesAvailable, 0);

    const refused = await api.request('DELETE', `/books/${book.body.id}`);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'BOOK_ON_LOAN');

    await api.request('POST', `/loans/${loan.body.id}/return`);
    const removed = await api.request('DELETE', `/books/${book.body.id}`);
    assert.equal(removed.status, 204);

    const gone = await api.request('GET', `/books/${book.body.id}`);
    assert.equal(gone.status, 404);
  });

  it('rejects invalid input', async () => {
    const noTitle = await api.request('POST', '/books', { author: 'Nobody', isbn: '123' });
    assert.equal(noTitle.status, 400);
    assert.equal(noTitle.body.code, 'VALIDATION_ERROR');

    const badCopies = await api.request('POST', '/books', { title: 'X', author: 'Y', isbn: '999', copies: 0 });
    assert.equal(badCopies.status, 400);

    const badJson = await api.request('POST', '/books', 'not json');
    assert.equal(badJson.status, 400);
    assert.equal(badJson.body.code, 'BAD_JSON');
  });
});
