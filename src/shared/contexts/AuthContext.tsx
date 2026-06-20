import { createContext, useContext, useState, useEffect, ReactNode, useCallback } from 'react';
import { getCurrentUser, getAuthToken, setAuthToken, removeAuthToken, isTokenExpired, registerRefreshHandler } from '../api/client';
import { logger } from '../utils/logger';

export type UserRole = 'contributor' | 'maintainer' | 'admin' | null;

export interface User {
  id: string;
  role: string;
  github?: {
    login: string;
    avatar_url: string;
    name?: string;
    email?: string;
    location?: string;
    bio?: string;
    website?: string;
  };
}

interface AuthContextType {
  userRole: UserRole;
  userId: string | null;
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (token: string) => Promise<void>;
  logout: () => void;
  refreshSession: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [userRole, setUserRole] = useState<UserRole>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const logout = useCallback(() => {
    logger.debug('AuthContext - logout() called');
    removeAuthToken();
    setUser(null);
    setUserRole(null);
    setUserId(null);
  }, []);

  const refreshSession = useCallback(async (): Promise<void> => {
    logger.debug('AuthContext - refreshSession() called');
    const token = getAuthToken();
    if (!token || isTokenExpired(token)) {
      logger.debug('AuthContext - refreshSession: token missing or expired client-side');
      logout();
      throw new Error('Session expired');
    }

    try {
      logger.debug('AuthContext - refreshSession: revalidating with getCurrentUser...');
      const userData = await getCurrentUser({ skipRefresh: true });
      logger.debug('AuthContext - refreshSession: user profile revalidated for ID:', userData.id);
      
      setUser(userData);
      setUserRole(userData.role as UserRole);
      setUserId(userData.id);
      
      const nowStr = new Date().toISOString();
      sessionStorage.setItem('patchwork_last_validated_at', nowStr);
      
      logger.info('AuthContext - Session re-validated successfully', {
        role: userData.role,
        id: userData.id
      });
    } catch (error) {
      logger.error('AuthContext - refreshSession: revalidation failed:', error instanceof Error ? error.message : error);
      const errMsg = error instanceof Error ? error.message : String(error);
      if (
        errMsg.includes('Authentication failed') ||
        errMsg.includes('Permission denied') ||
        errMsg.includes('401') ||
        errMsg.includes('unauthorized')
      ) {
        logout();
      }
      throw error;
    }
  }, [logout]);

  // Register the refresh handler with the client
  useEffect(() => {
    registerRefreshHandler(refreshSession);
  }, [refreshSession]);

  const checkAuth = async () => {
    const token = getAuthToken();
    logger.debug('AuthContext - Checking authentication on mount');
    logger.debug('AuthContext - Token found:', token ? 'Yes' : 'No');

    if (token) {
      if (isTokenExpired(token)) {
        logger.debug('AuthContext - Token is expired client-side');
        logout();
        setIsLoading(false);
        return;
      }

      try {
        logger.debug('AuthContext - Fetching user profile...');
        const userData = await getCurrentUser({ skipRefresh: true });
        logger.debug('AuthContext - User profile received for ID:', userData.id);
        setUser(userData);
        setUserRole(userData.role as UserRole);
        setUserId(userData.id);
        
        const nowStr = new Date().toISOString();
        sessionStorage.setItem('patchwork_last_validated_at', nowStr);

        logger.info('AuthContext - User authenticated', {
          role: userData.role,
          id: userData.id
        });
      } catch (error) {
        logger.error('AuthContext - Auth check failed:', error instanceof Error ? error.message : error);
        const errMsg = error instanceof Error ? error.message : String(error);
        if (errMsg.includes('Authentication failed') || errMsg.includes('Permission denied')) {
          logout();
        }
      }
    } else {
      logger.debug('AuthContext - No token found, user not authenticated');
      setUser(null);
      setUserRole(null);
      setUserId(null);
    }
    setIsLoading(false);
    logger.debug('AuthContext - Loading complete');
  };

  // Check for existing token on mount
  useEffect(() => {
    checkAuth();
  }, []);

  // Keep auth state in sync when token changes (logout in same tab, 401s, etc).
  useEffect(() => {
    const onTokenEvent = (e: Event) => {
      const ce = e as CustomEvent<{ token: string | null }>;
      const token = ce.detail?.token ?? null;
      if (!token) {
        setUser(null);
        setUserRole(null);
        setUserId(null);
        return;
      }
      checkAuth();
    };

    const onStorage = (e: StorageEvent) => {
      if (e.key !== 'patchwork_jwt') return;
      if (!e.newValue) {
        setUser(null);
        setUserRole(null);
        setUserId(null);
        return;
      }
      checkAuth();
    };

    window.addEventListener('patchwork-auth-token', onTokenEvent);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('patchwork-auth-token', onTokenEvent);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  // Re-validate when the tab regains focus
  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (document.visibilityState === 'visible') {
        const token = getAuthToken();
        if (!token) return;

        if (isTokenExpired(token)) {
          logger.debug('AuthContext - Visibility change: Token expired client-side');
          logout();
          return;
        }

        const lastValidated = sessionStorage.getItem('patchwork_last_validated_at');
        const now = new Date();
        const thresholdMs = 60 * 1000; // 60 seconds threshold

        let shouldRevalidate = true;
        if (lastValidated) {
          const lastValDate = new Date(lastValidated);
          if (!isNaN(lastValDate.getTime())) {
            const diffMs = now.getTime() - lastValDate.getTime();
            if (diffMs < thresholdMs) {
              shouldRevalidate = false;
            }
          }
        }

        if (shouldRevalidate) {
          logger.debug('AuthContext - Visibility change: triggering revalidation');
          try {
            await refreshSession();
          } catch (err) {
            logger.debug('AuthContext - Visibility change revalidation error:', err);
          }
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [refreshSession]);

  const login = async (token: string) => {
    logger.debug('AuthContext - login() called');
    setAuthToken(token);
    logger.debug('AuthContext - Token saved to localStorage');

    try {
      logger.debug('AuthContext - Fetching user profile after login...');
      const userData = await getCurrentUser({ skipRefresh: true });
      logger.debug('AuthContext - User profile received for ID:', userData.id);
      setUser(userData);
      setUserRole(userData.role as UserRole);
      setUserId(userData.id);
      
      const nowStr = new Date().toISOString();
      sessionStorage.setItem('patchwork_last_validated_at', nowStr);
      
      logger.info('AuthContext - Login successful for ID:', userData.id);
    } catch (error) {
      logger.error('AuthContext - Login failed:', error instanceof Error ? error.message : error);
      removeAuthToken();
      throw error;
    }
  };

  return (
    <AuthContext.Provider
      value={{
        userRole,
        userId,
        user,
        isAuthenticated: !!user && !!getAuthToken(),
        isLoading,
        login,
        logout,
        refreshSession,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
