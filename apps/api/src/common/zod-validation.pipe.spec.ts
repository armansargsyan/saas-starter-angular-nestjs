import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from './zod-validation.pipe';

const pipe = new ZodValidationPipe(
  z.strictObject({
    name: z.string().min(2),
    age: z.coerce.number().default(1),
  }),
);

describe('ZodValidationPipe', () => {
  it('returns the parsed value', () => {
    expect(pipe.transform({ name: 'Ada' })).toEqual({ name: 'Ada', age: 1 });
  });

  it('throws a 400 listing each issue by path', () => {
    try {
      pipe.transform({ name: 'A', extra: 'secret-value' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      const body = (err as BadRequestException).getResponse();
      expect(body).toMatchObject({ message: 'Validation failed' });
      expect(JSON.stringify(body)).toContain('"path":"name"');
      expect(JSON.stringify(body)).not.toContain('secret-value');
    }
  });
});
