/**
 * Small helpers that turn untrusted JSON payloads into validated values.
 * Every failure is a 400 with a readable message.
 */

import { badRequest } from './errors.js';

export type JsonObject = Record<string, unknown>;

export function asObject(value: unknown, what = 'request body'): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest(`${what} must be a JSON object`);
  }
  return value as JsonObject;
}

export function readString(source: JsonObject, field: string, maxLength = 500): string {
  const raw = source[field];
  if (typeof raw !== 'string') {
    throw badRequest(`"${field}" is required and must be a string`);
  }
  const value = raw.trim();
  if (value === '') {
    throw badRequest(`"${field}" must not be empty`);
  }
  if (value.length > maxLength) {
    throw badRequest(`"${field}" must be at most ${maxLength} characters`);
  }
  return value;
}

export function readOptionalPositiveInt(source: JsonObject, field: string): number | undefined {
  const raw = source[field];
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    throw badRequest(`"${field}" must be a positive integer`);
  }
  return raw;
}

/**
 * Read an optional list of short, non-empty strings (used for book tags).
 * Blank entries are dropped, duplicates are removed case-insensitively, and
 * the result preserves the first spelling seen (lower-cased).
 */
export function readOptionalStringList(
  source: JsonObject,
  field: string,
  options: { maxItems?: number; maxLength?: number; toLowerCase?: boolean } = {},
): string[] | undefined {
  const raw = source[field];
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (!Array.isArray(raw)) {
    throw badRequest(`"${field}" must be an array of strings`);
  }
  const maxItems = options.maxItems ?? 20;
  const maxLength = options.maxLength ?? 40;
  if (raw.length > maxItems) {
    throw badRequest(`"${field}" must contain at most ${maxItems} entries`);
  }
  const seen = new Set<string>();
  const values: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      throw badRequest(`"${field}" must be an array of strings`);
    }
    const trimmed = entry.trim();
    if (trimmed === '') {
      continue;
    }
    if (trimmed.length > maxLength) {
      throw badRequest(`every "${field}" entry must be at most ${maxLength} characters`);
    }
    const value = options.toLowerCase === false ? trimmed : trimmed.toLowerCase();
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    values.push(value);
  }
  return values;
}

export function readQueryString(value: string | null, field: string): string | undefined {
  if (value === null) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return undefined;
  }
  if (trimmed.length > 500) {
    throw badRequest(`query parameter "${field}" is too long`);
  }
  return trimmed;
}
