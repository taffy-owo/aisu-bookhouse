import { afterEach, expect, it, vi } from 'vitest';
import { apiRequest } from './apiClient';
import { getApiServerTime, observeApiServerTime, resetApiServerClock } from './serverClock';

const serverTime = Date.parse('2026-10-29T10:00:00Z');
afterEach(() => { resetApiServerClock(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('advances server time monotonically despite a device wall clock correction', () => {
  let elapsed = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
  vi.spyOn(Date, 'now').mockReturnValue(serverTime - 3600_000);
  observeApiServerTime(new Headers({ Date: new Date(serverTime).toUTCString() }), 800);
  expect(getApiServerTime()).toBe(serverTime);
  elapsed += 1500;
  vi.spyOn(Date, 'now').mockReturnValue(serverTime + 3600_000);
  expect(getApiServerTime()).toBe(serverTime + 1500);
});

it('ignores older requests and cached or malformed samples', () => {
  vi.spyOn(performance, 'now').mockReturnValue(1000);
  observeApiServerTime(new Headers({ Date: new Date(serverTime).toUTCString() }), 800);
  for (const headers of [new Headers(), new Headers({ Date: 'invalid' }), new Headers({ Date: 'Thu, 01 Jan 2026 00:00:00 GMT', Age: '120' }), new Headers({ Date: 'Thu, 01 Jan 2026 00:00:00 GMT', Age: 'invalid' })]) {
    observeApiServerTime(headers, 900);
    expect(getApiServerTime()).toBe(serverTime);
  }
  observeApiServerTime(new Headers({ Date: 'Thu, 01 Jan 2026 00:00:00 GMT' }), 700);
  observeApiServerTime(new Headers({ Date: 'Thu, 01 Jan 2026 00:00:00 GMT' }), 2000);
  expect(getApiServerTime()).toBe(serverTime);
});

it('falls back to device time until a fresh API sample is available', () => {
  vi.spyOn(Date, 'now').mockReturnValue(serverTime);
  expect(getApiServerTime()).toBe(serverTime);
});

it('observes real API response headers without changing the response payload', async () => {
  vi.spyOn(performance, 'now').mockReturnValue(1000);
  vi.spyOn(Date, 'now').mockReturnValue(serverTime + 3600_000);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true }, { headers: { Date: new Date(serverTime).toUTCString(), Age: '0' } })));
  expect(await apiRequest('/books')).toEqual({ ok: true });
  expect(getApiServerTime()).toBe(serverTime);
});
