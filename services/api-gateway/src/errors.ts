/**
 * Maps the shared GW-* error registry (@terminal/types) onto Fastify responses.
 * Every auth failure the client sees goes through here so messages stay
 * consistent and never leak internals (CLAUDE.md §9).
 */
import type { FastifyReply } from 'fastify';
import { ERROR_CODES, type ErrorCode } from '@terminal/types';

const STATUS_BY_CODE: Partial<Record<ErrorCode, number>> = {
  'GW-2001': 401,
  'GW-2002': 401,
  'GW-2003': 403,
  'GW-2004': 429,
  'GW-2005': 400,
  'GW-2006': 409,
  'GW-2007': 401,
  'GW-2008': 400,
  'GW-2009': 500,
  'GW-2010': 400,
  'GW-2011': 400,
  'GW-2012': 404,
  'GW-2013': 400,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, string | number | boolean> | undefined;

  constructor(code: ErrorCode, details?: Record<string, string | number | boolean>) {
    super(ERROR_CODES[code]);
    this.code = code;
    this.details = details;
  }
}

export function sendAppError(reply: FastifyReply, err: AppError): FastifyReply {
  const status = STATUS_BY_CODE[err.code] ?? 400;
  return reply.code(status).send({
    error: { code: err.code, message: ERROR_CODES[err.code], details: err.details },
  });
}
