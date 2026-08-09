/**
 * Wire types for the EveryPage API.
 *
 * Transcribed from frontend/public/openapi.yaml, with the readership report
 * taken from backend/internal/handlers/files.go (HandleGetFileAnalytics) and
 * analytics.go (HandleGetPageAnalytics) - the spec describes that response
 * only loosely, because its shape depends on the owner's plan.
 *
 * Almost everything is optional on purpose. Sections above the caller's tier
 * are ABSENT rather than null or zero, and older files predate several
 * fields; code that assumes presence breaks on a free-tier account.
 */

export interface PageRange {
  from: number;
  to: number;
}

export interface EveryPageFile {
  uuid: string;
  shortId?: string;
  slug?: string;
  originalName?: string;
  size?: number;
  mimeType?: string;
  createdAt?: string;
  updatedAt?: string;
  deleteAt?: string | null;
  viewCount?: number;
  totalPages?: number;
  viewerMode?: "standard" | "flipbook" | "swipe" | "magazine";
  /** True when a passcode is set. The passcode itself is never returned. */
  protected?: boolean;
  allowDownload?: boolean;
  requireEmail?: boolean;
  notifyOnView?: boolean;
  pageRange?: PageRange;
  contentVersion?: number;
  palette?: string[];
  canvaDesignId?: string;
  canvaUpdatesEnabled?: boolean;
}

/** POST /api/v1/files. `shareUrl` is built server-side (see files.go:399). */
export interface UploadResult {
  uuid: string;
  shortId?: string;
  shareUrl?: string;
  message?: string;
}

export interface Variant {
  uuid: string;
  shortId?: string;
  /** Server-built, already durable - prefer it over reconstructing. */
  url?: string;
  label?: string;
  overrides?: VariantOverrides;
  revoked?: boolean;
  redactedAt?: string;
  createdAt?: string;
}

export interface VariantOverrides {
  allowDownload?: boolean;
  pageRange?: PageRange;
}

export type EventType = "view" | "download" | "gate";

export interface ReadEvent {
  id: number;
  fileUuid?: string;
  fileName?: string;
  readAt?: string;
  country?: string;
  /** view events only; always serialized there, including 0. */
  pagesViewed?: number;
  /** view events only. */
  timeMs?: number;
  type?: EventType;
  /** gate events only: the submitted form fields. */
  fields?: Record<string, string>;
}

export interface Webhook {
  uuid: string;
  url?: string;
  events?: string[];
  format?: "json" | "slack";
  active?: boolean;
  consecutiveFailures?: number;
  createdAt?: string;
  fileUuid?: string;
}

export interface WebhookCreateResult extends Webhook {
  /** Shown exactly once, at creation. */
  secret?: string;
}

export interface WebhookTestResult {
  delivered?: boolean;
  status?: number;
  latencyMs?: number;
  error?: string;
}

export interface Breakdown {
  label: string;
  count: number;
}

export interface FunnelPoint {
  page: number;
  reached: number;
  pct: number;
}

export interface VariantStat {
  uuid: string;
  label?: string;
  sessions: number;
  avgTimeMs: number;
  revoked: boolean;
  redacted: boolean;
}

export interface ReadershipSummary {
  totalViews?: number;
  totalSessions?: number;
  uniqueVisitors?: number;
  uniqueCountries?: number;
  avgTimeMs?: number;
  downloads?: number;
  // Basic+
  medianTimeMs?: number;
  completionRate?: number;
  totalTurns?: number;
  backTurnShare?: number;
  // Pro
  activeReaders?: number;
  newSessions?: number;
  returningSessions?: number;
  invitedNotViewed?: number;
}

/** GET /api/v1/files/{uuid}/readership. Sections above the tier are absent. */
export interface ReadershipReport {
  file?: EveryPageFile;
  tier?: "free" | "basic" | "pro";
  summary?: ReadershipSummary;
  /**
   * Present only when a page range limits non-owner viewers: the size of the
   * shared window. The funnel's deeper pages are structurally unreachable
   * then, so a drop-off there is not reader behaviour.
   */
  effectivePages?: number;
  // Basic+
  funnel?: FunnelPoint[];
  countries?: Breakdown[];
  devices?: Breakdown[];
  browsers?: Breakdown[];
  sources?: Breakdown[];
  referrers?: Breakdown[];
  viewerModes?: Breakdown[];
  viewsOverTime?: { day: string; count: number }[];
  peakTimes?: { dow: number; hour: number; count: number }[];
  // Pro
  sessions?: unknown[];
  variants?: VariantStat[];
  contacts?: { fields: Record<string, string>; createdAt: string }[];
}

export interface PageStat {
  pageNumber: number;
  views: number;
  avgDurationMs: number;
  /** Views arriving via BACKWARD navigation - the re-read signal. */
  backTurns: number;
}

/** GET /api/v1/files/{uuid}/readership/pages (Basic+). */
export interface PageReport {
  pages?: PageStat[];
  totalPages?: number;
}
