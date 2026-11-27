import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

export interface ValidationErrorBody {
  statusCode: 400;
  error: 'Bad Request';
  message: 'Validation failed';
  issues: { path: string; message: string }[];
}

/**
 * Validates and parses a body/query/param with a zod schema from libs/shared.
 * Unknown fields are rejected by the (strict) schemas; values are never echoed.
 */
export class ZodValidationPipe<S extends z.ZodType> implements PipeTransform {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.output<S> {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;

    const body: ValidationErrorBody = {
      statusCode: 400,
      error: 'Bad Request',
      message: 'Validation failed',
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    };
    throw new BadRequestException(body);
  }
}
