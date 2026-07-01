<script lang="ts">
  import type { Action } from '$lib/api.js';
  import StatusBadge from './StatusBadge.svelte';

  export let action: Action;

  function reltime(ts: number | null): string {
    if (!ts) return '—';
    const diff = Math.floor(Date.now() / 1000) - ts;
    if (diff < 60)   return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }
</script>

<div class="action-row">
  <div class="action-meta">
    <span class="mono text-xs text-muted">{action.id.slice(0, 12)}</span>
    <StatusBadge status={action.status} pulse={action.status === 'running'} />
  </div>
  <div class="action-type">{action.type.replace(/_/g, ' ')}</div>
  <div class="action-time text-xs text-muted">{reltime(action.created_at)}</div>
  {#if action.result?.error}
    <div class="action-error text-xs text-red">{action.result.error}</div>
  {/if}
</div>

<style>
  .action-row {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: var(--sp-3);
    padding: var(--sp-3);
    border-bottom: 1px solid var(--border);
    transition: background var(--t-fast);
  }
  .action-row:hover { background: var(--bg-raised); }
  .action-row:last-child { border-bottom: none; }
  .action-meta { display: flex; align-items: center; gap: var(--sp-2); }
  .action-type {
    font-size: var(--text-sm);
    font-family: var(--font-mono);
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: var(--text-xs);
  }
  .action-error { grid-column: 1 / -1; padding-left: var(--sp-2); }
</style>
