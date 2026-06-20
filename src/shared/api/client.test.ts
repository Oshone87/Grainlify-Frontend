// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { 
  getAuthToken, 
  setAuthToken, 
  removeAuthToken, 
  isTokenExpired, 
  registerRefreshHandler, 
  getCurrentUser 
} from './client';

const generateToken = (payload: object): string => {
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = btoa(JSON.stringify(header))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  const encodedPayload = btoa(JSON.stringify(payload))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${encodedHeader}.${encodedPayload}.signature`;
};

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => { store[key] = String(value); },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
  };
})();
vi.stubGlobal('localStorage', localStorageMock);


describe('isTokenExpired', () => {
  it('should return true if token is null or empty', () => {
    expect(isTokenExpired(null)).toBe(true);
    expect(isTokenExpired('')).toBe(true);
  });

  it('should return true if token is malformed', () => {
    expect(isTokenExpired('not-a-token')).toBe(true);
    expect(isTokenExpired('part1.part2')).toBe(true);
  });

  it('should return true if payload has no exp claim', () => {
    const token = generateToken({ sub: '1234' });
    expect(isTokenExpired(token)).toBe(true);
  });

  it('should return true if token is expired', () => {
    const exp = Math.floor(Date.now() / 1000) - 60; // 60s ago
    const token = generateToken({ exp });
    expect(isTokenExpired(token)).toBe(true);
  });

  it('should return true if token is near expiry (within clock skew)', () => {
    const exp = Math.floor(Date.now() / 1000) + 5; // 5s in future, less than 10s skew
    const token = generateToken({ exp });
    expect(isTokenExpired(token)).toBe(true);
  });

  it('should return false if token is valid and not expired', () => {
    const exp = Math.floor(Date.now() / 1000) + 120; // 2 minutes in future
    const token = generateToken({ exp });
    expect(isTokenExpired(token)).toBe(false);
  });
});

describe('apiRequest 401 retry and deduplication', () => {
  beforeEach(() => {
    localStorage.clear();
    registerRefreshHandler(async () => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should call refreshHandler and retry on 401', async () => {
    const token = generateToken({ exp: Math.floor(Date.now() / 1000) + 120 });
    setAuthToken(token);

    let refreshCalled = false;
    registerRefreshHandler(async () => {
      refreshCalled = true;
      const newToken = generateToken({ exp: Math.floor(Date.now() / 1000) + 240 });
      setAuthToken(newToken);
    });

    let fetchCount = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      fetchCount++;
      if (fetchCount === 1) {
        return {
          ok: false,
          status: 401,
          json: async () => ({ error: 'Unauthorized' })
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: '123' })
      };
    }));

    const result = await getCurrentUser();
    expect(refreshCalled).toBe(true);
    expect(result).toEqual({ id: '123' });
    expect(fetchCount).toBe(2);
    expect(getAuthToken()).not.toBe(token);
  });

  it('should deduplicate multiple concurrent 401 refreshes', async () => {
    const token = generateToken({ exp: Math.floor(Date.now() / 1000) + 120 });
    setAuthToken(token);

    let refreshCount = 0;
    let resolveRefresh: any;
    const refreshPromise = new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    });

    registerRefreshHandler(async () => {
      refreshCount++;
      await refreshPromise;
      const newToken = generateToken({ exp: Math.floor(Date.now() / 1000) + 240 });
      setAuthToken(newToken);
    });

    let fetchCount = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      fetchCount++;
      if (fetchCount <= 2) {
        return {
          ok: false,
          status: 401,
          json: async () => ({ error: 'Unauthorized' })
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true })
      };
    }));

    const req1 = getCurrentUser();
    const req2 = getCurrentUser();

    await new Promise((resolve) => setTimeout(resolve, 10));
    resolveRefresh();

    const [res1, res2] = await Promise.all([req1, req2]);

    expect(refreshCount).toBe(1);
    expect(res1).toEqual({ success: true });
    expect(res2).toEqual({ success: true });
  });
});
