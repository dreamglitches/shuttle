// Shuttle Web — Svelte stores
import { writable, derived } from 'svelte/store';
import type { Server, GlobalSettings } from './api.js';

// Auth state
export const authed = writable<boolean>(false);

// Server list
export const serverList = writable<Server[]>([]);

// Currently viewed server
export const currentServer = writable<Server | null>(null);

// Global settings
export const globalSettings = writable<GlobalSettings | null>(null);

// Toast notifications
export interface Toast { id: string; message: string; type: 'success' | 'error' | 'info'; }
export const toasts = writable<Toast[]>([]);

export function showToast(message: string, type: Toast['type'] = 'info', durationMs = 4000) {
  const id = Math.random().toString(36).slice(2);
  toasts.update(t => [...t, { id, message, type }]);
  setTimeout(() => toasts.update(t => t.filter(x => x.id !== id)), durationMs);
}

// Derived: servers grouped by status
export const activeServers   = derived(serverList, $s => $s.filter(s => s.status === 'active'));
export const staleServers    = derived(serverList, $s => $s.filter(s => s.status === 'stale'));
export const archivedServers = derived(serverList, $s => $s.filter(s => s.status === 'archived'));
