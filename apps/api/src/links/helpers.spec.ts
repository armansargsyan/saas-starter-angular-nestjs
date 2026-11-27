import { describe, expect, it } from 'vitest';
import { Clock } from '../common/clock';
import { deviceType, referrerHost, utcDay } from './click-info';
import {
  MAX_REFERRERS_PER_DAY,
  OTHER_REFERRER,
  ReferrerBudget,
} from './referrer-budget';
import {
  CLICKS_PER_WINDOW,
  CLICK_WINDOW_MS,
  ClickLimiter,
  clientKey,
} from './click-limiter';
import { generateShortCode, isPlausibleCode } from './short-code';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const MAC_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

describe('generateShortCode', () => {
  it('makes 7 base62 characters', () => {
    for (let i = 0; i < 100; i++) {
      expect(generateShortCode()).toMatch(/^[0-9A-Za-z]{7}$/);
    }
  });

  it('does not repeat in practice', () => {
    const codes = new Set(
      Array.from({ length: 1000 }, () => generateShortCode()),
    );
    expect(codes.size).toBe(1000);
  });
});

describe('isPlausibleCode', () => {
  it.each(['abc', 'aB3xY9z', 'my-link'])('accepts %s', (code) => {
    expect(isPlausibleCode(code)).toBe(true);
  });

  it.each(['ab', 'a'.repeat(33), 'a/b', 'a.b', '../x', 'a b'])(
    'rejects %j',
    (code) => {
      expect(isPlausibleCode(code)).toBe(false);
    },
  );
});

describe('deviceType', () => {
  it('detects mobile, desktop and bots', () => {
    expect(deviceType(IPHONE)).toBe('mobile');
    expect(deviceType(MAC_CHROME)).toBe('desktop');
    expect(deviceType('Googlebot/2.1 (+http://www.google.com/bot.html)')).toBe(
      'bot',
    );
    expect(deviceType('curl/8.4.0')).toBe('bot');
    expect(deviceType(undefined)).toBe('bot');
  });
});

describe('referrerHost', () => {
  it('keeps only the host, lowercased, without www', () => {
    expect(referrerHost('https://WWW.Example.com/path?q=secret')).toBe(
      'example.com',
    );
    expect(referrerHost('http://news.ycombinator.com/')).toBe(
      'news.ycombinator.com',
    );
  });

  it.each([
    undefined,
    '',
    'not a url',
    'android-app://com.foo',
    'file:///etc',
    'http://__name__/',
  ])('drops %j', (value) => {
    expect(referrerHost(value)).toBeNull();
  });
});

describe('utcDay', () => {
  it('formats the UTC date', () => {
    expect(utcDay(new Date('2026-03-01T23:59:59-05:00'))).toBe('2026-03-02');
  });
});

describe('ClickLimiter', () => {
  function limiter() {
    let now = 0;
    const clock = { now: () => new Date(now) } as Clock;
    return {
      limiter: new ClickLimiter(clock),
      advance: (ms: number) => (now += ms),
    };
  }

  it('counts up to the limit per IP and link, then resets after the window', () => {
    const { limiter: l, advance } = limiter();
    for (let i = 0; i < CLICKS_PER_WINDOW; i++) {
      expect(l.allow('1.1.1.1', 'abc')).toBe(true);
    }
    expect(l.allow('1.1.1.1', 'abc')).toBe(false);
    expect(l.allow('1.1.1.1', 'other')).toBe(true);
    expect(l.allow('2.2.2.2', 'abc')).toBe(true);

    advance(CLICK_WINDOW_MS);
    expect(l.allow('1.1.1.1', 'abc')).toBe(true);
  });

  it('always counts clicks without an IP', () => {
    const { limiter: l } = limiter();
    for (let i = 0; i < CLICKS_PER_WINDOW + 5; i++) {
      expect(l.allow(undefined, 'abc')).toBe(true);
    }
  });
});

describe('clientKey', () => {
  it('keeps IPv4 (also IPv4-mapped IPv6) as is', () => {
    expect(clientKey('1.2.3.4')).toBe('1.2.3.4');
    expect(clientKey('::ffff:1.2.3.4')).toBe('1.2.3.4');
  });

  it('groups IPv6 by /64', () => {
    const a = clientKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd');
    expect(a).toBe('2001:db8:1:2::/64');
    expect(clientKey('2001:0db8:0001:0002::1')).toBe(a);
    expect(clientKey('2001:db8:1:3::1')).not.toBe(a);
    expect(clientKey('::1')).toBe('0:0:0:0::/64');
  });
});

describe('ClickLimiter under a flood of clients', () => {
  it("stops counting new clients without resetting others' windows", () => {
    const clock = { now: () => new Date(0) } as Clock;
    const l = new ClickLimiter(clock);
    for (let i = 0; i < CLICKS_PER_WINDOW; i++) l.allow('9.9.9.9', 'abc');
    for (let i = 0; i < 50_000; i++)
      l.allow(`10.${i >> 16}.${(i >> 8) & 255}.${i & 255}`, 'abc');

    expect(l.allow('9.9.9.9', 'abc')).toBe(false); // window kept
    expect(l.allow('8.8.8.8', 'abc')).toBe(false); // full: not counted
  });
});

describe('ReferrerBudget', () => {
  it('keeps known hosts and folds new ones into "other" past the cap', () => {
    const budget = new ReferrerBudget();
    for (let i = 0; i < MAX_REFERRERS_PER_DAY; i++) {
      expect(budget.admit('abc', '2026-01-01', `h${i}.com`)).toBe(`h${i}.com`);
    }
    expect(budget.admit('abc', '2026-01-01', 'new.com')).toBe(OTHER_REFERRER);
    expect(budget.admit('abc', '2026-01-01', 'h0.com')).toBe('h0.com');
    expect(budget.admit('abc', '2026-01-02', 'new.com')).toBe('new.com');
    expect(budget.admit('xyz', '2026-01-01', 'new.com')).toBe('new.com');
  });

  it("evicts the oldest entries when full, not everyone's budget", () => {
    const budget = new ReferrerBudget();
    for (let i = 0; i < MAX_REFERRERS_PER_DAY + 1; i++) {
      budget.admit('target', '2026-01-01', `h${i}.com`);
    }
    // Flood with new (link, day) keys; the oldest go first, so filling up
    // repeatedly never resets "target" in one go.
    for (let i = 0; i < 9_999; i++)
      budget.admit(`c${i}`, '2026-01-01', 'x.com');
    expect(budget.admit('target', '2026-01-01', 'fresh.com')).toBe(
      OTHER_REFERRER,
    );
  });
});
