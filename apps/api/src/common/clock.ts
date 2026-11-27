import { Injectable } from '@nestjs/common';

/** Current time, injectable so tests can pin it. */
@Injectable()
export class Clock {
  now(): Date {
    return new Date();
  }
}
