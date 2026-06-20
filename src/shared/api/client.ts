/**
 * API Client for Patchwork Backend
 * Base URL: http://7nonainmv1.loclx.io
 */

import { API_BASE_URL } from "../config/api";
import { BillingProfile } from "../../features/settings/types";
import { BlogPost } from "../../features/blog/types";

// Token management
export const getAuthToken = (): string | null => {
  return localStorage.getItem("patchwork_jwt");
};

export const setAuthToken = (token: string): void => {
  localStorage.setItem("patchwork_jwt", token);
  // Notify app code (AuthContext) immediately, since storage events don't fire
  // in the same tab that performed the write.
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("patchwork-auth-token", { detail: { token } }),
    );
  }
};

export const removeAuthToken = (): void => {
  const token = localStorage.getItem("patchwork_jwt");
  if (token === null) return; // Prevent duplicate logout triggers/events
  localStorage.removeItem("patchwork_jwt");
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("patchwork-auth-token", { detail: { token: null } }),
    );
  }
};

/**
 * Decodes the JWT payload to check if the token is expired.
 * Treating malformed tokens or missing expiration claim as expired.
 * 
 * @param token - The JWT string to evaluate.
 * @returns boolean - True if token is expired or invalid, false otherwise.
 */
export const isTokenExpired = (token: string | null): boolean => {
  if (!token) return true;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return true;

    // JWT payloads are base64url encoded.
    const base64Url = parts[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');

    // Base64 decoding helper that works in browser and Node/Vitest environments
    const decode = (str: string): string => {
      if (typeof window !== 'undefined' && typeof window.atob === 'function') {
        return window.atob(str);
      }
      const globalObj: any = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : {});
      if (globalObj && 'Buffer' in globalObj) {
        return globalObj.Buffer.from(str, 'base64').toString('binary');
      }
      throw new Error('No base64 decoding function available');
    };

    const jsonPayload = decodeURIComponent(
      decode(base64)
        .split('')
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    );

    const payload = JSON.parse(jsonPayload);
    if (!payload || typeof payload !== 'object' || !('exp' in payload)) {
      return true;
    }

    const exp = Number(payload.exp);
    if (isNaN(exp)) return true;

    // Proactive check: treat as expired if within 10 seconds of actual expiration (clock skew)
    const clockSkewSeconds = 10;
    const currentTimeSeconds = Math.floor(Date.now() / 1000);
    return currentTimeSeconds + clockSkewSeconds >= exp;
  } catch {
    return true;
  }
};

// Shared promise for active refresh session to deduplicate concurrent 401 refreshes
let refreshPromise: Promise<any> | null = null;
let refreshHandler: (() => Promise<any>) | null = null;

/**
 * Registers the function responsible for refreshing the user session.
 * This will be called when a request fails with a 401.
 */
export const registerRefreshHandler = (handler: () => Promise<any>): void => {
  refreshHandler = handler;
};

// API request helper
interface ApiRequestOptions extends RequestInit {
  requiresAuth?: boolean;
  skipRefresh?: boolean;
}

async function apiRequest<T>(
  endpoint: string,
  options: ApiRequestOptions = {},
): Promise<T> {
  const { requiresAuth = false, headers = {}, ...fetchOptions } = options;

  const url = `${API_BASE_URL}${endpoint}`;
  const requestHeaders: Record<string, string> = {};
  if (headers) {
    if (headers instanceof Headers) {
      headers.forEach((value, key) => {
        requestHeaders[key] = value;
      });
    } else if (Array.isArray(headers)) {
      headers.forEach(([key, value]) => {
        requestHeaders[key] = value;
      });
    } else {
      Object.assign(requestHeaders, headers);
    }
  }

  // Avoid forcing CORS preflight for simple GET/HEAD requests by only setting
  // Content-Type when we actually send a JSON body.
  const method = (fetchOptions.method || "GET").toUpperCase();
  const hasBody = fetchOptions.body !== undefined && fetchOptions.body !== null;
  if (hasBody && !(fetchOptions.body instanceof FormData)) {
    requestHeaders["Content-Type"] = "application/json";
  } else if (
    method !== "GET" &&
    method !== "HEAD" &&
    !("Content-Type" in requestHeaders)
  ) {
    // Non-GET/HEAD without an explicit content-type: default to JSON for our API.
    requestHeaders["Content-Type"] = "application/json";
  }

  // Add auth token if required
  if (requiresAuth) {
    const token = getAuthToken();
    if (token) {
      requestHeaders["Authorization"] = `Bearer ${token}`;
    }
  }

  let response: Response;
  try {
    response = await fetch(url, {
      ...fetchOptions,
      headers: requestHeaders,
    });
  } catch (err) {
    // Network error (CORS, connection refused, etc.)
    if (err instanceof TypeError && err.message.includes("fetch")) {
      throw new Error(
        "Network error: Unable to connect to the server. Please check your connection.",
      );
    }
    throw err;
  }

  // Handle errors
  if (!response.ok) {
    if (response.status === 401) {
      if (requiresAuth && refreshHandler && !options.skipRefresh) {
        if (!refreshPromise) {
          refreshPromise = refreshHandler().catch((err) => {
            removeAuthToken();
            throw err;
          }).finally(() => {
            refreshPromise = null;
          });
        }

        try {
          // Wait for the token refresh/validation to complete
          await refreshPromise;
        } catch (refreshErr) {
          throw new Error("Authentication failed. Please sign in again.");
        }

        const newToken = getAuthToken();
        if (newToken) {
          const retriedHeaders = {
            ...requestHeaders,
            'Authorization': `Bearer ${newToken}`
          };
          try {
            response = await fetch(url, {
              ...fetchOptions,
              headers: retriedHeaders,
            });
            if (response.ok) {
              try {
                return await response.json() as T;
              } catch (err) {
                if (endpoint.includes("/projects/mine") || endpoint.includes("/projects")) {
                  return [] as T;
                }
                throw new Error("Invalid response from server");
              }
            }
          } catch (err) {
            if (err instanceof TypeError && err.message.includes("fetch")) {
              throw new Error(
                "Network error: Unable to connect to the server. Please check your connection.",
              );
            }
            throw err;
          }
        }
      }

      // If we didn't retry or retry failed
      if (response.status === 401) {
        removeAuthToken();
        throw new Error("Authentication failed. Please sign in again.");
      }
    }

    if (response.status === 403) {
      // Forbidden - user doesn't have permission
      try {
        const errorData = await response.json();
        const errorMsg =
          errorData.message || errorData.error || "Access forbidden";
        throw new Error(
          `Permission denied: ${errorMsg}. You may need admin privileges to perform this action.`,
        );
      } catch {
        throw new Error(
          "Permission denied: You do not have permission to perform this action. Admin privileges may be required.",
        );
      }
    }

    // Try to parse error response
    try {
      const errorData = await response.json();
      throw new Error(
        errorData.message || errorData.error || "API request failed",
      );
    } catch {
      throw new Error(`API request failed with status ${response.status}`);
    }
  }

  // Parse JSON response
  try {
    const jsonData = await response.json();
    return jsonData;
  } catch (err) {
    // If response is empty or not JSON, return empty array for list endpoints
    if (endpoint.includes("/projects/mine") || endpoint.includes("/projects")) {
      return [] as T;
    }
    throw new Error("Invalid response from server");
  }
}

// API Methods

// Health & Status
export const checkHealth = () =>
  apiRequest<{ ok: boolean; service: string }>("/health");

export const checkReady = () =>
  apiRequest<{ ok: boolean; db: string }>("/ready");

// Landing stats (public)
export type LandingStats = {
  active_projects: number;
  contributors: number;
  grants_distributed_usd: number;
};

export const getLandingStats = () => apiRequest<LandingStats>("/stats/landing");

// Authentication
export const getCurrentUser = (options?: { skipRefresh?: boolean }) =>
  apiRequest<{
    id: string;
    role: string;
    first_name?: string;
    last_name?: string;
    location?: string;
    website?: string;
    bio?: string;
    avatar_url?: string;
    telegram?: string;
    linkedin?: string;
    whatsapp?: string;
    twitter?: string;
    discord?: string;
    github?: {
      login: string;
      avatar_url: string;
      name?: string;
      email?: string;
      location?: string;
      bio?: string;
      website?: string;
    };
  }>("/me", { requiresAuth: true, skipRefresh: options?.skipRefresh });

export const resyncGitHubProfile = () =>
  apiRequest<{
    github: {
      login: string;
      avatar_url: string;
      name?: string;
      email?: string;
      location?: string;
      bio?: string;
      website?: string;
    };
  }>("/me/github/resync", { requiresAuth: true, method: "POST" });

export const getGitHubLoginUrl = () => {
  // Pass the current frontend origin as redirect parameter
  // This allows the backend to redirect back to the correct frontend after OAuth
  const redirectAfterLogin = window.location.origin;
  return `${API_BASE_URL}/auth/github/login/start?redirect=${encodeURIComponent(redirectAfterLogin)}`;
};

export const getGitHubStatus = () =>
  apiRequest<{
    linked: boolean;
    github?: { id: number; login: string };
  }>("/auth/github/status", { requiresAuth: true });

// User Profile
export const getUserProfile = () =>
  apiRequest<{
    contributions_count: number;
    projects_contributed_to_count: number;
    projects_led_count: number;
    rewards_count: number;
    languages: Array<{ language: string; contribution_count: number }>;
    ecosystems: Array<{ ecosystem_name: string; contribution_count: number }>;
    kyc_verified?: boolean;
    rank: {
      position: number | null;
      tier: string;
      tier_name: string;
      tier_color: string;
    };
  }>("/profile", { requiresAuth: true });

export const getProfileCalendar = (userId?: string, login?: string) => {
  const params = new URLSearchParams();
  if (userId) params.append("user_id", userId);
  if (login) params.append("login", login);
  const query = params.toString() ? `?${params.toString()}` : "";
  return apiRequest<{
    calendar: Array<{ date: string; count: number; level: number }>;
    total: number;
  }>(`/profile/calendar${query}`, { requiresAuth: true });
};

export const getProfileActivity = (
  limit = 50,
  offset = 0,
  userId?: string,
  login?: string,
) => {
  const params = new URLSearchParams();
  params.append("limit", limit.toString());
  params.append("offset", offset.toString());
  if (userId) params.append("user_id", userId);
  if (login) params.append("login", login);
  return apiRequest<{
    activities: Array<{
      type: "pull_request" | "issue";
      id: string;
      number: number;
      title: string;
      url: string;
      state?: string;
      date: string;
      month_year: string;
      project_name: string;
      project_id: string;
      merged?: boolean;
      draft?: boolean;
    }>;
    total: number;
    limit: number;
    offset: number;
  }>(`/profile/activity?${params.toString()}`, { requiresAuth: true });
};

export const getProjectsContributed = (userId?: string, login?: string) => {
  const params = new URLSearchParams();
  if (userId) params.append("user_id", userId);
  if (login) params.append("login", login);
  const query = params.toString() ? `?${params.toString()}` : "";
  return apiRequest<
    Array<{
      id: string;
      github_full_name: string;
      status: string;
      ecosystem_name?: string;
      language?: string;
      owner_avatar_url?: string;
    }>
  >(`/profile/projects${query}`, { requiresAuth: true });
};

export const getProjectsLed = (userId?: string, login?: string) => {
  const params = new URLSearchParams();
  if (userId) params.append("user_id", userId);
  if (login) params.append("login", login);
  const query = params.toString() ? `?${params.toString()}` : "";
  return apiRequest<
    Array<{
      id: string;
      github_full_name: string;
      status: string;
      ecosystem_name?: string;
      language?: string;
      owner_avatar_url?: string;
    }>
  >(`/profile/projects-led${query}`, { requiresAuth: true });
};

export const getPublicProfile = (userId?: string, login?: string) => {
  const params = new URLSearchParams();
  if (userId) params.append("user_id", userId);
  if (login) params.append("login", login);
  return apiRequest<{
    login: string;
    user_id: string;
    avatar_url?: string;
    contributions_count: number;
    projects_contributed_to_count: number;
    projects_led_count: number;
    languages: Array<{ language: string; contribution_count: number }>;
    ecosystems: Array<{ ecosystem_name: string; contribution_count: number }>;
    bio?: string;
    website?: string;
    telegram?: string;
    linkedin?: string;
    whatsapp?: string;
    twitter?: string;
    discord?: string;
    kyc_verified?: boolean;
    rank: {
      position: number | null;
      tier: string;
      tier_name: string;
      tier_color: string;
    };
  }>(`/profile/public?${params.toString()}`, { requiresAuth: false });
};

export const updateProfile = (data: {
  first_name?: string;
  last_name?: string;
  location?: string;
  website?: string;
  bio?: string;
  telegram?: string;
  linkedin?: string;
  whatsapp?: string;
  twitter?: string;
  discord?: string;
}) =>
  apiRequest<{ message: string }>("/profile/update", {
    method: "PUT",
    body: JSON.stringify(data),
    requiresAuth: true,
  });

export const updateAvatar = (avatarUrl: string) =>
  apiRequest<{ message: string; avatar_url: string }>("/profile/avatar", {
    method: "PUT",
    body: JSON.stringify({ avatar_url: avatarUrl }),
    requiresAuth: true,
  });

// Projects
export const getPublicProjects = (params?: {
  ecosystem?: string;
  language?: string;
  category?: string;
  tags?: string;
  limit?: number;
  offset?: number;
}) => {
  const queryParams = new URLSearchParams();
  if (params?.ecosystem) queryParams.append("ecosystem", params.ecosystem);
  if (params?.language) queryParams.append("language", params.language);
  if (params?.category) queryParams.append("category", params.category);
  if (params?.tags) queryParams.append("tags", params.tags);
  if (params?.limit) queryParams.append("limit", params.limit.toString());
  if (params?.offset) queryParams.append("offset", params.offset.toString());

  const queryString = queryParams.toString();
  const endpoint = queryString ? `/projects?${queryString}` : "/projects";

  return apiRequest<{
    projects: Array<{
      id: string;
      github_full_name: string;
      language: string | null;
      tags: string[];
      category: string | null;
      stars_count: number;
      forks_count: number;
      contributors_count: number;
      open_issues_count: number;
      open_prs_count: number;
      ecosystem_name: string | null;
      ecosystem_slug: string | null;
      description?: string;
      created_at: string;
      updated_at: string;
    }>;
    total: number;
    limit: number;
    offset: number;
  }>(endpoint);
};

// Get recommended projects (top by contributors count)
export const getRecommendedProjects = (limit: number = 8) =>
  apiRequest<{
    projects: Array<{
      id: string;
      github_full_name: string;
      language: string | null;
      tags: string[];
      category: string | null;
      stars_count: number;
      forks_count: number;
      contributors_count: number;
      open_issues_count: number;
      open_prs_count: number;
      ecosystem_name: string | null;
      ecosystem_slug: string | null;
      description?: string;
      created_at: string;
      updated_at: string;
    }>;
  }>(`/projects/recommended?limit=${limit}`);

export const getPublicProject = (projectId: string) =>
  apiRequest<{
    id: string;
    github_full_name: string;
    language: string | null;
    tags: string[];
    category: string | null;
    stars_count: number;
    forks_count: number;
    contributors_count: number;
    open_issues_count: number;
    open_prs_count: number;
    ecosystem_name: string | null;
    ecosystem_slug: string | null;
    created_at: string;
    updated_at: string;
    languages: Array<{ name: string; percentage: number }>;
    readme?: string;
    repo?: {
      full_name: string;
      html_url: string;
      homepage: string;
      description: string;
      open_issues_count: number;
      owner_login: string;
      owner_avatar_url: string;
    };
  }>(`/projects/${projectId}`);

export const getPublicProjectIssues = (projectId: string) =>
  apiRequest<{
    issues: Array<{
      github_issue_id: number;
      number: number;
      state: string;
      title: string;
      description: string | null;
      author_login: string;
      labels: any[];
      url: string;
      updated_at: string | null;
      last_seen_at: string;
    }>;
  }>(`/projects/${projectId}/issues/public`);

export const getPublicProjectPRs = (projectId: string) =>
  apiRequest<{
    prs: Array<{
      github_pr_id: number;
      number: number;
      state: string;
      title: string;
      author_login: string;
      url: string;
      merged: boolean;
      created_at: string | null;
      updated_at: string | null;
      closed_at: string | null;
      merged_at: string | null;
      last_seen_at: string;
    }>;
  }>(`/projects/${projectId}/prs/public`);

export const getProjectFilters = () =>
  apiRequest<{
    languages: string[];
    categories: string[];
    tags: string[];
  }>("/projects/filters");

// Ecosystems
export const getEcosystems = () =>
  apiRequest<{
    ecosystems: Array<{
      id: string;
      slug: string;
      name: string;
      description: string | null;
      logo_url: string | null;
      website_url: string | null;
      status: string;
      project_count: number;
      user_count: number;
      created_at: string;
      updated_at: string;
    }>;
  }>("/ecosystems");

export type EcosystemDetail = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  website_url: string | null;
  logo_url: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  about?: string | null;
  links?: Array<{ label: string; url: string }> | null;
  key_areas?: Array<{ title: string; description: string }> | null;
  technologies?: string[] | null;
  project_count: number;
  contributors_count: number;
  open_issues_count: number;
  open_prs_count: number;
};

export const getEcosystemDetail = (id: string) =>
  apiRequest<EcosystemDetail>(`/ecosystems/${id}`);

// Open Source Week
export const getOpenSourceWeekEvents = () =>
  apiRequest<{
    events: Array<{
      id: string;
      title: string;
      description: string | null;
      location: string | null;
      status: string;
      start_at: string;
      end_at: string;
      created_at: string;
      updated_at: string;
    }>;
  }>("/open-source-week/events");

export const getOpenSourceWeekEvent = (id: string) =>
  apiRequest<{
    event: {
      id: string;
      title: string;
      description: string | null;
      location: string | null;
      status: string;
      start_at: string;
      end_at: string;
      created_at: string;
      updated_at: string;
    };
  }>(`/open-source-week/events/${id}`);

export const getAdminOpenSourceWeekEvents = () =>
  apiRequest<{
    events: Array<{
      id: string;
      title: string;
      description: string | null;
      location: string | null;
      status: string;
      start_at: string;
      end_at: string;
      created_at: string;
      updated_at: string;
    }>;
  }>("/admin/open-source-week/events", { requiresAuth: true, method: "GET" });

export const createOpenSourceWeekEvent = (data: {
  title: string;
  description?: string;
  location?: string;
  status: "upcoming" | "running" | "completed" | "draft";
  start_at: string; // RFC3339
  end_at: string; // RFC3339
}) =>
  apiRequest<{ id: string }>("/admin/open-source-week/events", {
    requiresAuth: true,
    method: "POST",
    body: JSON.stringify(data),
  });

export const deleteOpenSourceWeekEvent = (id: string) =>
  apiRequest<{ ok: boolean }>(`/admin/open-source-week/events/${id}`, {
    requiresAuth: true,
    method: "DELETE",
  });

export const createEcosystem = (data: {
  name: string;
  description?: string;
  website_url?: string;
  logo_url?: string;
  status: "active" | "inactive";
  about?: string;
  links?: Array<{ label: string; url: string }>;
  key_areas?: Array<{ title: string; description: string }>;
  technologies?: string[];
}) =>
  apiRequest<{
    id: string;
    slug: string;
    name: string;
    description: string;
    website_url: string;
    status: string;
    project_count: number;
    user_count: number;
    created_at: string;
    updated_at: string;
  }>("/admin/ecosystems", {
    requiresAuth: true,
    method: "POST",
    body: JSON.stringify(data),
  });

export const getAdminEcosystems = () =>
  apiRequest<{
    ecosystems: Array<{
      id: string;
      slug: string;
      name: string;
      description: string | null;
      logo_url: string | null;
      website_url: string | null;
      status: string;
      project_count: number;
      user_count: number;
      created_at: string;
      updated_at: string;
      about: string | null;
      links: Array<{ label: string; url: string }> | null;
      key_areas: Array<{ title: string; description: string }> | null;
      technologies: string[] | null;
    }>;
  }>("/admin/ecosystems", {
    requiresAuth: true,
    method: "GET",
  });

export const getAdminEcosystem = (id: string) =>
  apiRequest<{
    id: string;
    slug: string;
    name: string;
    description: string | null;
    logo_url: string | null;
    website_url: string | null;
    status: string;
    project_count: number;
    user_count: number;
    created_at: string;
    updated_at: string;
    about: string | null;
    links: Array<{ label: string; url: string }> | null;
    key_areas: Array<{ title: string; description: string }> | null;
    technologies: string[] | null;
  }>(`/admin/ecosystems/${id}`, {
    requiresAuth: true,
    method: "GET",
  });

export const deleteEcosystem = (id: string) =>
  apiRequest<{
    ok: boolean;
  }>(`/admin/ecosystems/${id}`, {
    requiresAuth: true,
    method: "DELETE",
  });

export const updateEcosystem = (id: string, data: {
  name: string;
  description?: string;
  website_url?: string;
  logo_url?: string;
  status: 'active' | 'inactive';
  about?: string;
  links?: Array<{ label: string; url: string }>;
  key_areas?: Array<{ title: string; description: string }>;
  technologies?: string[];
}) =>
  apiRequest<{
    id: string;
    slug: string;
    name: string;
    description: string;
    website_url: string;
    status: string;
    project_count: number;
    user_count: number;
    created_at: string;
    updated_at: string;
  }>(`/admin/ecosystems/${id}`, {
    requiresAuth: true,
    method: 'PUT',
    body: JSON.stringify(data),
  });

// Leaderboard
export const getLeaderboard = (limit = 10, offset = 0, ecosystem?: string) =>
  apiRequest<
    Array<{
      rank: number;
      rank_tier: string;
      rank_tier_name: string;
      username: string;
      avatar: string;
      user_id: string;
      contributions: number;
      ecosystems: string[];
      score: number;
      trend: "up" | "down" | "same";
      trendValue: number;
    }>
  >(
    `/leaderboard?limit=${limit}&offset=${offset}${ecosystem ? `&ecosystem=${ecosystem}` : ""
    }`,
  );

// Admin Bootstrap
export const bootstrapAdmin = (bootstrapToken: string) =>
  apiRequest<{
    ok: boolean;
    token: string;
    role: string;
  }>("/admin/bootstrap", {
    requiresAuth: true,
    method: "POST",
    headers: {
      "X-Admin-Bootstrap-Token": bootstrapToken,
    },
  });

// KYC
export const startKYCVerification = () =>
  apiRequest<{
    session_id: string;
    url: string;
  }>("/auth/kyc/start", {
    requiresAuth: true,
    method: "POST",
  });

export const getKYCStatus = () =>
  apiRequest<{
    status: string | null;
    session_id?: string;
    verified_at?: string;
    rejection_reason?: string;
    data?: any;
    extracted?: any;
  }>("/auth/kyc/status", { requiresAuth: true });

export const getBillingProfiles = () =>
  apiRequest<BillingProfile[]>("/billing/profiles", { requiresAuth: true });

export const getBlogPosts = () =>
  apiRequest<BlogPost[]>("/blog/posts", { requiresAuth: false });


export const getMyProjects = () =>
  apiRequest<
    Array<{
      id: string;
      github_full_name: string;
      github_repo_id: number;
      status: string;
      ecosystem_name: string;
      language: string;
      tags: string[];
      category: string;
      description?: string | null;
      verification_error: string | null;
      verified_at: string | null;
      webhook_created_at: string | null;
      webhook_id: number | null;
      webhook_url: string | null;
      owner_avatar_url?: string;
      created_at: string;
      updated_at: string;
      needs_metadata?: boolean;
    }>
  >("/projects/mine", { requiresAuth: true });

export const createProject = (data: {
  github_full_name: string;
  ecosystem_name: string;
  language?: string;
  tags?: string[];
  category?: string;
}) =>
  apiRequest<{
    id: string;
    github_full_name: string;
    status: string;
    ecosystem_name: string;
    language: string;
    tags: string[];
    category: string;
    created_at: string;
    updated_at: string;
  }>("/projects", {
    requiresAuth: true,
    method: "POST",
    body: JSON.stringify(data),
  });

export type PendingSetupProject = {
  id: string;
  github_full_name: string;
  description: string | null;
  ecosystem_id: string;
  ecosystem_name: string;
  language: string | null;
  tags: string[];
  category: string | null;
};

export const getPendingSetupProjects = () =>
  apiRequest<PendingSetupProject[]>("/projects/pending-setup", {
    requiresAuth: true,
  });

export const updateProjectMetadata = (
  projectId: string,
  data: {
    description?: string;
    ecosystem_name?: string;
    language?: string;
    tags?: string[];
    category?: string;
  },
) =>
  apiRequest<{ ok: boolean }>(`/projects/${projectId}/metadata`, {
    requiresAuth: true,
    method: "PUT",
    body: JSON.stringify(data),
  });

export const verifyProject = (projectId: string) =>
  apiRequest<{
    id: string;
    status: string;
    verified_at: string;
    webhook_id: number;
    webhook_url: string;
  }>(`/projects/${projectId}/verify`, {
    requiresAuth: true,
    method: "POST",
  });

export const syncProject = (projectId: string) =>
  apiRequest<{
    ok: boolean;
    message: string;
  }>(`/projects/${projectId}/sync`, {
    requiresAuth: true,
    method: "POST",
  });

// Project Data (Issues and PRs)
export const getProjectIssues = (projectId: string) =>
  apiRequest<{
    issues: Array<{
      github_issue_id: number;
      number: number;
      state: string;
      title: string;
      description: string | null;
      author_login: string;
      assignees: any[];
      labels: any[];
      comments_count: number;
      comments: any[];
      url: string;
      updated_at: string | null;
      last_seen_at: string;
    }>;
  }>(`/projects/${projectId}/issues`, { requiresAuth: true });

export const getProjectPRs = (projectId: string) =>
  apiRequest<{
    prs: Array<{
      github_pr_id: number;
      number: number;
      state: string;
      title: string;
      author_login: string;
      url: string;
      merged: boolean;
      created_at: string | null;
      updated_at: string | null;
      closed_at: string | null;
      merged_at: string | null;
      last_seen_at: string;
    }>;
  }>(`/projects/${projectId}/prs`, { requiresAuth: true });

export const applyToIssue = (
  projectId: string,
  issueNumber: number,
  message: string,
) =>
  apiRequest<{
    ok: boolean;
    comment: {
      id: number;
      body: string;
      user: { login: string };
      created_at: string;
      updated_at: string;
    };
  }>(`/projects/${projectId}/issues/${issueNumber}/apply`, {
    requiresAuth: true,
    method: "POST",
    body: JSON.stringify({ message }),
  });

export const postBotComment = (
  projectId: string,
  issueNumber: number,
  body: string,
) =>
  apiRequest<{
    ok: boolean;
    comment: {
      id: number;
      body: string;
      user: { login: string };
      created_at: string;
      updated_at: string;
    };
  }>(`/projects/${projectId}/issues/${issueNumber}/bot-comment`, {
    requiresAuth: true,
    method: "POST",
    body: JSON.stringify({ body }),
  });

export const withdrawApplication = (
  projectId: string,
  issueNumber: number,
  commentId: number,
) =>
  apiRequest<{ ok: boolean }>(
    `/projects/${projectId}/issues/${issueNumber}/withdraw`,
    {
      requiresAuth: true,
      method: "POST",
      body: JSON.stringify({ comment_id: commentId }),
    },
  );

export const assignApplicant = (
  projectId: string,
  issueNumber: number,
  assignee: string,
) =>
  apiRequest<{ ok: boolean }>(
    `/projects/${projectId}/issues/${issueNumber}/assign`,
    {
      requiresAuth: true,
      method: "POST",
      body: JSON.stringify({ assignee }),
    },
  );

export const unassignApplicant = (projectId: string, issueNumber: number) =>
  apiRequest<{ ok: boolean }>(
    `/projects/${projectId}/issues/${issueNumber}/unassign`,
    {
      requiresAuth: true,
      method: "POST",
    },
  );

export const rejectApplication = (
  projectId: string,
  issueNumber: number,
  assignee: string,
) =>
  apiRequest<{ ok: boolean }>(
    `/projects/${projectId}/issues/${issueNumber}/reject`,
    {
      requiresAuth: true,
      method: "POST",
      body: JSON.stringify({ assignee }),
    },
  );
