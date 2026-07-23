import { UnprocessableEntityException, type ValidationError } from '@nestjs/common';

/**
 * Laravel returns validation failures as HTTP 422 with the shape:
 *   { "message": "<first error>", "errors": { "<field>": ["<msg>", …] } }
 * The React SPA reads `response.data.errors` / `.message` directly, so NestJS
 * must reproduce this shape exactly. These helpers do that.
 */

export type FieldErrors = Record<string, string[]>;

/**
 * Build the summary `message` exactly like Laravel's ValidationException::summarize():
 * first error message, plus " (and N more errors)" when more than one message exists.
 */
export function summarizeErrors(errors: FieldErrors): string {
  const all = Object.values(errors).flat();
  if (all.length === 0 || typeof all[0] !== 'string') return 'The given data was invalid.';
  let message = all[0];
  const count = all.length - 1;
  if (count > 0) message += ` (and ${count} more ${count === 1 ? 'error' : 'errors'})`;
  return message;
}

/** Throw a Laravel-style 422 with the given field errors. */
export function throwValidation(errors: FieldErrors): never {
  throw new UnprocessableEntityException({ message: summarizeErrors(errors), errors });
}

/**
 * ValidationPipe exceptionFactory that converts class-validator errors into the
 * Laravel 422 shape (field => messages), including nested constraints.
 */
export function laravelValidationExceptionFactory(errors: ValidationError[]): UnprocessableEntityException {
  const fieldErrors: FieldErrors = {};

  const walk = (list: ValidationError[]): void => {
    for (const e of list) {
      if (e.constraints) {
        fieldErrors[e.property] = Object.values(e.constraints);
      }
      if (e.children && e.children.length) walk(e.children);
    }
  };
  walk(errors);

  return new UnprocessableEntityException({ message: summarizeErrors(fieldErrors), errors: fieldErrors });
}
