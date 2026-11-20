/**
 * The in-memory domain model of the library: books, members and loans.
 *
 * Everything is synchronous and every operation that depends on the current
 * time receives it as an explicit argument, which makes the rules easy to test
 * and lets the HTTP layer plug in the `X-Fake-Now` header.
 * The shapes returned here are already the JSON shapes the API exposes.
 */

import { randomUUID } from 'node:crypto';
import { addDays, daysBetween } from './clock.js';
import { badRequest, conflict, notFound } from './errors.js';
import { asObject, readOptionalPositiveInt, readString } from './validate.js';

/* ------------------------------------------------------------------ rules */

/** A loan runs for 14 days. */
export const LOAN_PERIOD_DAYS = 14;
/** A renewal extends a loan by 7 days. */
export const RENEWAL_PERIOD_DAYS = 7;
/** A loan can be renewed exactly once. */
export const MAX_RENEWALS = 1;
/** A member may hold at most 5 active loans. */
export const MAX_ACTIVE_LOANS = 5;
/** Returning a loan more than this many days after its due date suspends the member. */
export const LATE_RETURN_DAYS = 14;
/** Automatic suspension length after a very late return. */
export const SUSPENSION_DAYS = 7;

/* ---------------------------------------------------------------- records */

interface BookRecord {
  id: string;
  isbn: string;
  isbnRaw: string;
  title: string;
  author: string;
  copiesOwned: number;
}

interface MemberRecord {
  id: string;
  name: string;
  email: string;
  suspendedUntil: Date | null;
}

interface LoanRecord {
  id: string;
  bookId: string;
  memberId: string;
  borrowedAt: Date;
  dueAt: Date;
  returnedAt: Date | null;
  renewals: number;
}

/* ------------------------------------------------------------------ views */

export interface BookView {
  id: string;
  isbn: string;
  title: string;
  author: string;
  copiesOwned: number;
  copiesOnLoan: number;
  copiesAvailable: number;
}

export interface MemberView {
  id: string;
  name: string;
  email: string;
  suspended: boolean;
  suspendedUntil: string | null;
  activeLoans: number;
}

export type LoanStatus = 'active' | 'overdue' | 'returned';

export interface LoanView {
  id: string;
  memberId: string;
  bookId: string;
  borrowedAt: string;
  dueAt: string;
  returnedAt: string | null;
  renewals: number;
  status: LoanStatus;
  daysOverdue: number;
  book: { id: string; title: string; author: string; isbn: string } | null;
  member: { id: string; name: string; email: string } | null;
}

export interface BookFilter {
  q?: string | undefined;
  title?: string | undefined;
  author?: string | undefined;
  isbn?: string | undefined;
}

export interface LoanFilter {
  memberId?: string | undefined;
  bookId?: string | undefined;
  status?: LoanStatus | undefined;
}

/* ---------------------------------------------------------------- helpers */

/** ISBNs are compared ignoring case, spaces and hyphens. */
export function normalizeIsbn(isbn: string): string {
  return isbn.replace(/[\s-]/g, '').toUpperCase();
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function later(a: Date | null, b: Date): Date {
  return a !== null && a.getTime() > b.getTime() ? a : b;
}

function matches(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/** Newest first: most recently borrowed loan leads; ties broken by later due date. */
function newestFirst(a: LoanRecord, b: LoanRecord): number {
  const byBorrowed = b.borrowedAt.getTime() - a.borrowedAt.getTime();
  if (byBorrowed !== 0) return byBorrowed;
  return b.dueAt.getTime() - a.dueAt.getTime();
}

/* ---------------------------------------------------------------- library */

export class Library {
  readonly #books = new Map<string, BookRecord>();
  readonly #booksByIsbn = new Map<string, string>();
  readonly #members = new Map<string, MemberRecord>();
  readonly #membersByEmail = new Map<string, string>();
  readonly #loans = new Map<string, LoanRecord>();

  /* -------------------------------------------------------------- books */

  /**
   * Add a book. An ISBN that is already known increases the number of owned
   * copies instead of creating a second record.
   */
  addBook(input: unknown): { book: BookView; created: boolean } {
    const body = asObject(input);
    const title = readString(body, 'title');
    const author = readString(body, 'author');
    const isbnRaw = readString(body, 'isbn', 32);
    const isbn = normalizeIsbn(isbnRaw);
    if (isbn === '') {
      throw badRequest('"isbn" must contain at least one letter or digit');
    }
    const copies = readOptionalPositiveInt(body, 'copies') ?? 1;

    const existing = this.#books.get(this.#booksByIsbn.get(isbn) ?? '');
    if (existing !== undefined) {
      existing.copiesOwned += copies;
      return { book: this.#bookView(existing), created: false };
    }

    const book: BookRecord = { id: randomUUID(), isbn, isbnRaw, title, author, copiesOwned: copies };
    this.#books.set(book.id, book);
    this.#booksByIsbn.set(isbn, book.id);
    return { book: this.#bookView(book), created: true };
  }

  listBooks(filter: BookFilter): BookView[] {
    const isbnFilter = filter.isbn === undefined ? undefined : normalizeIsbn(filter.isbn);
    return [...this.#books.values()]
      .filter((book) => {
        if (filter.q !== undefined && !matches(book.title, filter.q) && !matches(book.author, filter.q)) {
          return false;
        }
        if (filter.title !== undefined && !matches(book.title, filter.title)) {
          return false;
        }
        if (filter.author !== undefined && !matches(book.author, filter.author)) {
          return false;
        }
        if (isbnFilter !== undefined && book.isbn !== isbnFilter) {
          return false;
        }
        return true;
      })
      .map((book) => this.#bookView(book));
  }

  getBook(bookId: string): BookView {
    return this.#bookView(this.#requireBook(bookId));
  }

  /** Remove a book; refused while any of its copies is on loan. */
  removeBook(bookId: string): void {
    const book = this.#requireBook(bookId);
    const onLoan = this.#activeLoansForBook(book.id);
    if (onLoan.length > 0) {
      throw conflict(
        'BOOK_ON_LOAN',
        `Book "${book.title}" cannot be removed: ${onLoan.length} of ${book.copiesOwned} copies still on loan`,
      );
    }
    this.#books.delete(book.id);
    this.#booksByIsbn.delete(book.isbn);
  }

  /* ------------------------------------------------------------ members */

  registerMember(input: unknown, now: Date): MemberView {
    const body = asObject(input);
    const name = readString(body, 'name', 200);
    const emailRaw = readString(body, 'email', 320);
    const email = normalizeEmail(emailRaw);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw badRequest('"email" must be a valid email address');
    }
    if (this.#membersByEmail.has(email)) {
      throw conflict('DUPLICATE_EMAIL', `A member with email "${email}" already exists`);
    }
    const member: MemberRecord = { id: randomUUID(), name, email, suspendedUntil: null };
    this.#members.set(member.id, member);
    this.#membersByEmail.set(email, member.id);
    return this.#memberView(member, now);
  }

  listMembers(now: Date): MemberView[] {
    return [...this.#members.values()].map((member) => this.#memberView(member, now));
  }

  getMember(memberId: string, now: Date): MemberView {
    return this.#memberView(this.#requireMember(memberId), now);
  }

  /** Suspend a member for `days` (default 7) or until an explicit `until`. */
  suspendMember(memberId: string, input: unknown, now: Date): MemberView {
    const member = this.#requireMember(memberId);
    const body = input === undefined ? {} : asObject(input);
    let until: Date;
    const rawUntil = body['until'];
    if (rawUntil !== undefined) {
      if (typeof rawUntil !== 'string') {
        throw badRequest('"until" must be an ISO-8601 date-time');
      }
      const parsed = new Date(rawUntil);
      if (Number.isNaN(parsed.getTime())) {
        throw badRequest('"until" must be an ISO-8601 date-time');
      }
      if (parsed.getTime() <= now.getTime()) {
        throw badRequest('"until" must be in the future');
      }
      until = parsed;
    } else {
      until = addDays(now, readOptionalPositiveInt(body, 'days') ?? SUSPENSION_DAYS);
    }
    member.suspendedUntil = later(member.suspendedUntil, until);
    return this.#memberView(member, now);
  }

  /** Lift a suspension early. */
  unsuspendMember(memberId: string, now: Date): MemberView {
    const member = this.#requireMember(memberId);
    member.suspendedUntil = null;
    return this.#memberView(member, now);
  }

  /* -------------------------------------------------------------- loans */

  /**
   * Lend a copy to a member for 14 days.
   *
   * Fails when no copy is available, the member is suspended, the member
   * already holds 5 active loans, or the member has an overdue loan.
   */
  borrowBook(input: unknown, now: Date): LoanView {
    const body = asObject(input);
    const member = this.#requireMember(readString(body, 'memberId'));
    const book = this.#requireBook(readString(body, 'bookId'));

    const available = book.copiesOwned - this.#activeLoansForBook(book.id).length;
    if (available <= 0) {
      throw conflict('NO_COPIES', `No copy of "${book.title}" is available (${book.copiesOwned} owned, all on loan)`);
    }
    if (this.#isSuspended(member, now)) {
      throw conflict(
        'MEMBER_SUSPENDED',
        `Member "${member.name}" is suspended until ${member.suspendedUntil?.toISOString() ?? 'unknown'}`,
      );
    }
    const active = this.#activeLoansForMember(member.id);
    if (active.length >= MAX_ACTIVE_LOANS) {
      throw conflict(
        'LOAN_LIMIT',
        `Member "${member.name}" already has ${active.length} active loans (limit ${MAX_ACTIVE_LOANS})`,
      );
    }
    const overdue = active.find((loan) => loan.dueAt.getTime() < now.getTime());
    if (overdue !== undefined) {
      throw conflict(
        'MEMBER_OVERDUE',
        `Member "${member.name}" has an overdue loan (due ${overdue.dueAt.toISOString()})`,
      );
    }

    const loan: LoanRecord = {
      id: randomUUID(),
      bookId: book.id,
      memberId: member.id,
      borrowedAt: now,
      dueAt: addDays(now, LOAN_PERIOD_DAYS),
      returnedAt: null,
      renewals: 0,
    };
    this.#loans.set(loan.id, loan);
    return this.#loanView(loan, now);
  }

  /** Return a copy; a return more than 14 days late suspends the member for 7 days. */
  returnLoan(loanId: string, now: Date): LoanView {
    const loan = this.#requireLoan(loanId);
    if (loan.returnedAt !== null) {
      throw conflict('ALREADY_RETURNED', `Loan ${loan.id} was already returned on ${loan.returnedAt.toISOString()}`);
    }
    loan.returnedAt = now;

    const lateDays = daysBetween(loan.dueAt, now);
    if (lateDays > LATE_RETURN_DAYS) {
      const member = this.#members.get(loan.memberId);
      if (member !== undefined) {
        member.suspendedUntil = later(member.suspendedUntil, addDays(now, SUSPENSION_DAYS));
      }
    }
    return this.#loanView(loan, now);
  }

  /**
   * Renew a loan once for 7 more days.
   *
   * Fails while the loan is already overdue, has already been renewed, or the
   * borrowing member is suspended: a suspended member renews nothing.
   */
  renewLoan(loanId: string, now: Date): LoanView {
    const loan = this.#requireLoan(loanId);
    if (loan.returnedAt !== null) {
      throw conflict('ALREADY_RETURNED', `Loan ${loan.id} was already returned`);
    }
    const member = this.#members.get(loan.memberId);
    if (member !== undefined && this.#isSuspended(member, now)) {
      throw conflict(
        'MEMBER_SUSPENDED',
        `Member "${member.name}" is suspended until ${member.suspendedUntil?.toISOString() ?? 'unknown'} and cannot renew loans`,
      );
    }
    if (loan.renewals >= MAX_RENEWALS) {
      throw conflict('ALREADY_RENEWED', `Loan ${loan.id} was already renewed once`);
    }
    if (loan.dueAt.getTime() < now.getTime()) {
      throw conflict('LOAN_OVERDUE', `Loan ${loan.id} is overdue (due ${loan.dueAt.toISOString()}) and cannot be renewed`);
    }
    loan.dueAt = addDays(loan.dueAt, RENEWAL_PERIOD_DAYS);
    loan.renewals += 1;
    return this.#loanView(loan, now);
  }

  listLoans(filter: LoanFilter, now: Date): LoanView[] {
    return [...this.#loans.values()]
      .filter((loan) => {
        if (filter.memberId !== undefined && loan.memberId !== filter.memberId) return false;
        if (filter.bookId !== undefined && loan.bookId !== filter.bookId) return false;
        if (filter.status !== undefined && this.#loanStatus(loan, now) !== filter.status) return false;
        return true;
      })
      .map((loan) => this.#loanView(loan, now));
  }

  /**
   * Loan history of one member: every loan, active and returned, newest first
   * (most recently borrowed first). Fails for an unknown member.
   */
  loanHistory(memberId: string, now: Date): LoanView[] {
    const member = this.#requireMember(memberId);
    return [...this.#loans.values()]
      .filter((loan) => loan.memberId === member.id)
      .sort(newestFirst)
      .map((loan) => this.#loanView(loan, now));
  }

  /** Active loans whose due date is in the past, most overdue first. */
  overdueLoans(now: Date): LoanView[] {
    return [...this.#loans.values()]
      .filter((loan) => loan.returnedAt === null && loan.dueAt.getTime() < now.getTime())
      .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime())
      .map((loan) => this.#loanView(loan, now));
  }

  /* ------------------------------------------------------------ private */

  #requireBook(bookId: string): BookRecord {
    const book = this.#books.get(bookId);
    if (book === undefined) {
      throw notFound(`Book ${bookId} was not found`);
    }
    return book;
  }

  #requireMember(memberId: string): MemberRecord {
    const member = this.#members.get(memberId);
    if (member === undefined) {
      throw notFound(`Member ${memberId} was not found`);
    }
    return member;
  }

  #requireLoan(loanId: string): LoanRecord {
    const loan = this.#loans.get(loanId);
    if (loan === undefined) {
      throw notFound(`Loan ${loanId} was not found`);
    }
    return loan;
  }

  #activeLoansForBook(bookId: string): LoanRecord[] {
    return [...this.#loans.values()].filter((loan) => loan.bookId === bookId && loan.returnedAt === null);
  }

  #activeLoansForMember(memberId: string): LoanRecord[] {
    return [...this.#loans.values()].filter((loan) => loan.memberId === memberId && loan.returnedAt === null);
  }

  #isSuspended(member: MemberRecord, now: Date): boolean {
    return member.suspendedUntil !== null && member.suspendedUntil.getTime() > now.getTime();
  }

  #loanStatus(loan: LoanRecord, now: Date): LoanStatus {
    if (loan.returnedAt !== null) return 'returned';
    return loan.dueAt.getTime() < now.getTime() ? 'overdue' : 'active';
  }

  #bookView(book: BookRecord): BookView {
    const onLoan = this.#activeLoansForBook(book.id).length;
    return {
      id: book.id,
      isbn: book.isbnRaw,
      title: book.title,
      author: book.author,
      copiesOwned: book.copiesOwned,
      copiesOnLoan: onLoan,
      copiesAvailable: book.copiesOwned - onLoan,
    };
  }

  #memberView(member: MemberRecord, now: Date): MemberView {
    return {
      id: member.id,
      name: member.name,
      email: member.email,
      suspended: this.#isSuspended(member, now),
      suspendedUntil: member.suspendedUntil === null ? null : member.suspendedUntil.toISOString(),
      activeLoans: this.#activeLoansForMember(member.id).length,
    };
  }

  #loanView(loan: LoanRecord, now: Date): LoanView {
    const book = this.#books.get(loan.bookId);
    const member = this.#members.get(loan.memberId);
    const end = loan.returnedAt ?? now;
    const daysOverdue = daysBetween(loan.dueAt, end);
    return {
      id: loan.id,
      memberId: loan.memberId,
      bookId: loan.bookId,
      borrowedAt: loan.borrowedAt.toISOString(),
      dueAt: loan.dueAt.toISOString(),
      returnedAt: loan.returnedAt === null ? null : loan.returnedAt.toISOString(),
      renewals: loan.renewals,
      status: this.#loanStatus(loan, now),
      daysOverdue: daysOverdue > 0 ? daysOverdue : 0,
      book: book === undefined ? null : { id: book.id, title: book.title, author: book.author, isbn: book.isbnRaw },
      member: member === undefined ? null : { id: member.id, name: member.name, email: member.email },
    };
  }
}
