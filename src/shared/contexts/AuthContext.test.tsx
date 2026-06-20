// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthProvider, useAuth } from './AuthContext';
import * as client from '../api/client';

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof client>();
  return {
    ...actual,
    getCurrentUser: vi.fn(),
    getAuthToken: vi.fn(),
    setAuthToken: vi.fn(),
    removeAuthToken: vi.fn(),
    isTokenExpired: vi.fn(),
    registerRefreshHandler: vi.fn(),
  };
});

const storageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => { store[key] = String(value); },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
  };
})();
vi.stubGlobal('localStorage', storageMock);
vi.stubGlobal('sessionStorage', storageMock);


describe('AuthContext', () => {
  let container: HTMLDivElement;
  let root: any;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    localStorage.clear();
    sessionStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  // A helper component to inspect context values in test
  const TestConsumer = ({ onRender }: { onRender: (auth: any) => void }) => {
    const auth = useAuth();
    onRender(auth);
    return null;
  };

  it('should initialize with null state when no token is present', async () => {
    vi.mocked(client.getAuthToken).mockReturnValue(null);
    let capturedAuth: any = null;

    await act(async () => {
      root.render(
        <AuthProvider>
          <TestConsumer onRender={(auth) => { capturedAuth = auth; }} />
        </AuthProvider>
      );
    });

    expect(capturedAuth.isAuthenticated).toBe(false);
    expect(capturedAuth.user).toBeNull();
    expect(capturedAuth.isLoading).toBe(false);
  });

  it('should fetch user when valid token is present on mount', async () => {
    vi.mocked(client.getAuthToken).mockReturnValue('valid-token');
    vi.mocked(client.isTokenExpired).mockReturnValue(false);
    const mockUser = { id: 'user-123', role: 'contributor' };
    vi.mocked(client.getCurrentUser).mockResolvedValue(mockUser);

    let capturedAuth: any = null;

    await act(async () => {
      root.render(
        <AuthProvider>
          <TestConsumer onRender={(auth) => { capturedAuth = auth; }} />
        </AuthProvider>
      );
    });

    expect(client.getCurrentUser).toHaveBeenCalledWith({ skipRefresh: true });
    expect(capturedAuth.isAuthenticated).toBe(true);
    expect(capturedAuth.user).toEqual(mockUser);
    expect(sessionStorage.getItem('patchwork_last_validated_at')).toBeDefined();
  });

  it('should logout on mount if token is expired', async () => {
    vi.mocked(client.getAuthToken).mockReturnValue('expired-token');
    vi.mocked(client.isTokenExpired).mockReturnValue(true);

    let capturedAuth: any = null;

    await act(async () => {
      root.render(
        <AuthProvider>
          <TestConsumer onRender={(auth) => { capturedAuth = auth; }} />
        </AuthProvider>
      );
    });

    expect(client.removeAuthToken).toHaveBeenCalled();
    expect(capturedAuth.isAuthenticated).toBe(false);
    expect(capturedAuth.user).toBeNull();
  });

  it('should revalidate user when visibilitychange occurs and threshold passed', async () => {
    vi.mocked(client.getAuthToken).mockReturnValue('valid-token');
    vi.mocked(client.isTokenExpired).mockReturnValue(false);
    const mockUser = { id: 'user-123', role: 'contributor' };
    vi.mocked(client.getCurrentUser).mockResolvedValue(mockUser);

    await act(async () => {
      root.render(
        <AuthProvider>
          <TestConsumer onRender={() => {}} />
        </AuthProvider>
      );
    });

    vi.mocked(client.getCurrentUser).mockClear();

    // Set validation time to 2 minutes ago (after mount validation has run and set it to now)
    const lastValidated = new Date(Date.now() - 120 * 1000).toISOString();
    sessionStorage.setItem('patchwork_last_validated_at', lastValidated);

    // Trigger visibilitychange to visible
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      writable: true,
      configurable: true
    });

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(client.getCurrentUser).toHaveBeenCalled();
  });
});
