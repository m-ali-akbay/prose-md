import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { isoAfter, startServer, type TestServer } from './helpers.js';

const CLI = fileURLToPath(new URL('../../client/libctl', import.meta.url));
const PYTHON = process.env['PYTHON'] ?? 'python3';
const T0 = '2024-03-01T09:00:00.000Z';

const execFileAsync = promisify(execFile);

function pythonAvailable(): boolean {
  try {
    return spawnSync(PYTHON, ['--version'], { encoding: 'utf8' }).status === 0;
  } catch {
    return false;
  }
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the client asynchronously: the service under test lives in this very
 * process, so blocking calls such as `spawnSync` would deadlock it.
 */
async function runCli(args: string[], env: Record<string, string>): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(PYTHON, [CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

describe('libctl command line client', () => {
  let api: TestServer;
  let env: Record<string, string>;

  before(async () => {
    api = await startServer();
    env = { LIBRARY_URL: api.url };
  });

  after(async () => {
    await api.close();
  });

  it('adds a book and searches for it', async (t) => {
    if (!pythonAvailable()) {
      t.skip(`${PYTHON} is not available`);
      return;
    }

    const added = await runCli(
      ['add-book', '--title', 'Dune', '--author', 'Frank Herbert', '--isbn', '9780441013593', '--copies', '3'],
      env,
    );
    assert.equal(added.code, 0, added.stderr);
    assert.match(added.stdout, /TITLE/);
    assert.match(added.stdout, /Dune/);
    assert.match(added.stdout, /9780441013593/);

    const found = await runCli(['search', 'dune'], env);
    assert.equal(found.code, 0, found.stderr);
    assert.match(found.stdout, /Dune/);
    assert.match(found.stdout, /Frank Herbert/);

    const byAuthor = await runCli(['search', 'herbert', '--field', 'author'], env);
    assert.equal(byAuthor.code, 0, byAuthor.stderr);
    assert.match(byAuthor.stdout, /Dune/);

    const nothing = await runCli(['search', 'zzzzz'], env);
    assert.equal(nothing.code, 0);
    assert.match(nothing.stdout, /no books matched "zzzzz"/);
  });

  it('registers and lists members', async (t) => {
    if (!pythonAvailable()) {
      t.skip(`${PYTHON} is not available`);
      return;
    }

    const registered = await runCli(['register-member', '--name', 'Ada Lovelace', '--email', 'ada@example.com'], env);
    assert.equal(registered.code, 0, registered.stderr);
    assert.match(registered.stdout, /ada@example\.com/);
    assert.match(registered.stdout, /SUSPENDED/);

    const listed = await runCli(['list-members'], env);
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, /Ada Lovelace/);
  });

  it('borrows, renews, lists overdue loans and returns', async (t) => {
    if (!pythonAvailable()) {
      t.skip(`${PYTHON} is not available`);
      return;
    }

    const book = await api.request('POST', '/books', {
      title: 'The Left Hand of Darkness',
      author: 'Ursula K. Le Guin',
      isbn: '9780441478125',
    });
    const member = await api.request('POST', '/members', { name: 'Genly Ai', email: 'genly@example.com' });

    const borrowed = await runCli(['borrow', '--member', member.body.id, '--book', book.body.id, '--now', T0], env);
    assert.equal(borrowed.code, 0, borrowed.stderr);
    assert.match(borrowed.stdout, /LOAN/);
    assert.match(borrowed.stdout, /The Left Hand of Darkness/);
    assert.match(borrowed.stdout, /Genly Ai/);
    assert.match(borrowed.stdout, /2024-03-15/);

    const loans = await api.request('GET', `/loans?memberId=${member.body.id}`, undefined, { 'X-Fake-Now': T0 });
    assert.equal(loans.body.loans.length, 1);
    const loanId: string = loans.body.loans[0].id;

    const renewed = await runCli(['renew', '--loan', loanId, '--now', T0], env);
    assert.equal(renewed.code, 0, renewed.stderr);
    assert.match(renewed.stdout, /2024-03-22/);

    const notYet = await runCli(['overdue', '--now', T0], env);
    assert.equal(notYet.code, 0);
    assert.match(notYet.stdout, /no overdue loans/);

    const overdue = await runCli(['overdue', '--now', isoAfter(T0, 22)], env);
    assert.equal(overdue.code, 0, overdue.stderr);
    assert.match(overdue.stdout, /DAYS LATE/);
    assert.match(overdue.stdout, /The Left Hand of Darkness/);

    const returned = await runCli(['return', '--loan', loanId, '--now', isoAfter(T0, 23)], env);
    assert.equal(returned.code, 0, returned.stderr);
    assert.match(returned.stdout, /returned/);
  });

  it('shows the loan history of a member, newest first', async (t) => {
    if (!pythonAvailable()) {
      t.skip(`${PYTHON} is not available`);
      return;
    }

    const member = await api.request('POST', '/members', { name: 'Tomas Rivera', email: 'tomas@example.com' });
    const first = await api.request('POST', '/books', { title: 'Solaris', author: 'Stanislaw Lem', isbn: 'hist-1' });
    const second = await api.request('POST', '/books', { title: 'Piranesi', author: 'Susanna Clarke', isbn: 'hist-2' });

    const older = await api.request(
      'POST',
      '/loans',
      { memberId: member.body.id, bookId: first.body.id },
      { 'X-Fake-Now': T0 },
    );
    await api.request('POST', '/loans', { memberId: member.body.id, bookId: second.body.id }, {
      'X-Fake-Now': isoAfter(T0, 1),
    });
    await api.request('POST', `/loans/${older.body.id}/return`, undefined, { 'X-Fake-Now': isoAfter(T0, 2) });

    const history = await runCli(['history', '--member', member.body.id, '--now', isoAfter(T0, 3)], env);
    assert.equal(history.code, 0, history.stderr);
    assert.match(history.stdout, /BORROWED/);
    assert.match(history.stdout, /returned/);
    assert.match(history.stdout, /active/);

    const piranesi = history.stdout.indexOf('Piranesi');
    const solaris = history.stdout.indexOf('Solaris');
    assert.ok(piranesi >= 0 && solaris >= 0, 'both loans should be listed');
    assert.ok(piranesi < solaris, 'the newest loan comes first');

    const empty = await runCli(['history', '--member', 'no-such-member'], env);
    assert.notEqual(empty.code, 0);
    assert.equal(empty.stderr.trim().split('\n').length, 1);
    assert.match(empty.stderr, /^error: /);
  });

  it('adds books with tags and filters searches by tag', async (t) => {
    if (!pythonAvailable()) {
      t.skip(`${PYTHON} is not available`);
      return;
    }

    const added = await runCli(
      [
        'add-book',
        '--title', 'A Wizard of Earthsea',
        '--author', 'Ursula K. Le Guin',
        '--isbn', '9780547773742',
        '--tag', 'Fantasy',
        '--tag', 'young-adult',
      ],
      env,
    );
    assert.equal(added.code, 0, added.stderr);
    assert.match(added.stdout, /TAGS/);
    assert.match(added.stdout, /fantasy,young-adult/);

    const byTag = await runCli(['search', '--tag', 'FANTASY'], env);
    assert.equal(byTag.code, 0, byTag.stderr);
    assert.match(byTag.stdout, /A Wizard of Earthsea/);
    assert.doesNotMatch(byTag.stdout, /Dune\b/);

    const combined = await runCli(['search', 'earthsea', '--tag', 'fantasy'], env);
    assert.equal(combined.code, 0, combined.stderr);
    assert.match(combined.stdout, /A Wizard of Earthsea/);

    const mismatched = await runCli(['search', 'earthsea', '--tag', 'western'], env);
    assert.equal(mismatched.code, 0, mismatched.stderr);
    assert.match(mismatched.stdout, /no books matched/);

    const noCriteria = await runCli(['search'], env);
    assert.notEqual(noCriteria.code, 0);
    assert.match(noCriteria.stderr, /^error: /);
  });

  it('shows the fines of a member and pays them', async (t) => {
    if (!pythonAvailable()) {
      t.skip(`${PYTHON} is not available`);
      return;
    }

    const book = await api.request('POST', '/books', {
      title: 'The Dispossessed',
      author: 'Ursula K. Le Guin',
      isbn: '9780060512750',
    });
    const member = await api.request('POST', '/members', { name: 'Shevek', email: 'shevek@example.com' });

    const borrowed = await api.request('POST', '/loans', { memberId: member.body.id, bookId: book.body.id }, {
      'X-Fake-Now': T0,
    });
    await api.request('POST', `/loans/${borrowed.body.id}/return`, undefined, { 'X-Fake-Now': isoAfter(T0, 18) });

    const fines = await runCli(['fines', '--member', member.body.id], env);
    assert.equal(fines.code, 0, fines.stderr);
    assert.match(fines.stdout, /OUTSTANDING/);
    assert.match(fines.stdout, /1\.00/);
    assert.match(fines.stdout, /outstanding: 1\.00/);

    const partial = await runCli(['pay', '--member', member.body.id, '--amount', '0.25'], env);
    assert.equal(partial.code, 0, partial.stderr);
    assert.match(partial.stdout, /paid: 0\.25/);
    assert.match(partial.stdout, /outstanding: 0\.75/);

    const rest = await runCli(['pay', '--member', member.body.id], env);
    assert.equal(rest.code, 0, rest.stderr);
    assert.match(rest.stdout, /outstanding: 0\.00/);

    const failed = await runCli(['pay', '--member', member.body.id], env);
    assert.notEqual(failed.code, 0);
    assert.equal(failed.stderr.trim().split('\n').length, 1);
    assert.match(failed.stderr, /^error: /);
    assert.match(failed.stderr, /no outstanding fines/i);
  });

  it('prints service errors as one line and exits non-zero', async (t) => {
    if (!pythonAvailable()) {
      t.skip(`${PYTHON} is not available`);
      return;
    }

    const failed = await runCli(['return', '--loan', 'no-such-loan'], env);
    assert.notEqual(failed.code, 0);
    assert.equal(failed.stderr.trim().split('\n').length, 1);
    assert.match(failed.stderr, /^error: /);
    assert.match(failed.stderr, /not found/i);
  });

  it('reports a readable error when the service is unreachable', async (t) => {
    if (!pythonAvailable()) {
      t.skip(`${PYTHON} is not available`);
      return;
    }

    const failed = await runCli(['overdue'], { LIBRARY_URL: 'http://127.0.0.1:1' });
    assert.notEqual(failed.code, 0);
    assert.equal(failed.stderr.trim().split('\n').length, 1);
    assert.match(failed.stderr, /cannot reach the service/);
  });
});
