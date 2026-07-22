/**
 * Shared TypeScript types used across the backend.
 * Keep small and focused — add more as needed.
 */

export type WsPayload = { [k: string]: any };

export interface ApiResponse {
  success: boolean;
  error?: string | null;
}

export interface DeviceMetadata {
  model?: string;
  manufacturer?: string;
  androidVersion?: string;
  brand?: string;
  simOperator?: string;
  registeredAt?: number;
  [k: string]: any;
}
