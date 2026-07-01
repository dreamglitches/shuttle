<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { servers as serversApi, actions as actionsApi } from '$lib/api.js';
  import type { Server } from '$lib/api.js';
  import { serverList, showToast } from '$lib/stores.js';
  import StatusBadge from '$lib/components/StatusBadge.svelte';

  let loading = $state(true);
  let showArchived = $state(false);

  const displayed = $derived(
    showArchived ? $serverList : $serverList.filter(s => s.status !== 'archived')
  );

  async function load() {
    try {
      const data = await serversApi.list(showArchived);
      serverList.set(data);
    } catch {
      showToast('Failed to load servers', 'error');
    } finally {
      loading = false;
    }
  }

  let refreshTimer: ReturnType<typeof setInterval>;
  onMount(() => {
    load();
    refreshTimer = setInterval(load, 30_000);
  });
  onDestroy(() => clearInterval(refreshTimer));

  function reltime(ts: number): string {
    const diff = Math.floor(Date.now() / 1000) - ts;
    if (diff < 60)    return `${diff}s ago`;
    if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }

  async function quickSession(e: MouseEvent, server: Server) {
    e.stopPropagation();
    try {
      const a = await actionsApi.createSession(server.id, false);
      showToast(`Session requested — action ${a.id.slice(0, 8)}`, 'success');
      load();
    } catch (err: unknown) {
      showToast((err as { error: string }).error ?? 'Failed', 'error');
    }
  }

  async function quickKill(e: MouseEvent, server: Server) {
    e.stopPropagation();
    try {
      await actionsApi.killSession(server.id);
      showToast('Kill dispatched', 'success');
      load();
    } catch (err: unknown) {
      showToast((err as { error: string }).error ?? 'Failed', 'error');
    }
  }
</script>

<svelte:head>
  <title>Shuttle — Servers</title>
</svelte:head>

<div class="page-header">
  <div>
    <h1 class="page-title">Servers</h1>
    <p class="page-subtitle">
      {$serverList.filter(s => s.status === 'active').length} active ·
      {$serverList.filter(s => s.status === 'stale').length} stale
    </p>
  </div>

  <div class="flex gap-3 items-center">
    <label class="flex items-center gap-2 text-sm text-muted" style="cursor: pointer;">
      <input
        type="checkbox"
        bind:checked={showArchived}
        onchange={load}
        id="show-archived-toggle"
        style="accent-color: var(--accent-white);"
      />
      Show archived
    </label>
    <button class="btn btn-ghost btn-sm" onclick={load} id="refresh-btn">
      ↻ Refresh
    </button>
  </div>
</div>

{#if loading}
  <div class="loading-wrap">
    <span class="spinner"></span>
    <span class="text-muted text-sm">Loading servers…</span>
  </div>
{:else if displayed.length === 0}
  <div class="empty-state">
    <div class="empty-icon">⬡</div>
    <p>No servers yet.</p>
    <p class="text-muted text-sm">Install the Shuttle client on a server to get started.</p>
  </div>
{:else}
  <div class="server-grid">
    {#each displayed as server (server.id)}
      <div
        class="server-card card interactive"
        role="button"
        tabindex="0"
        onclick={() => goto(`/servers/${server.id}`)}
        onkeydown={(e) => e.key === 'Enter' && goto(`/servers/${server.id}`)}
        id="server-{server.id}"
        aria-label="View {server.name ?? server.id}"
      >
        <div class="server-card-top">
          <div class="server-identity">
            <span class="server-name">{server.name ?? server.id.slice(0, 16)}</span>
            <StatusBadge status={server.status} />
          </div>
          <div class="server-meta text-xs text-muted">
            {server.arch ?? '?'} · {server.client_version ?? 'unknown'} · {reltime(server.last_seen_at)}
          </div>
        </div>

        <div class="server-indicators">
          {#if server.current_session_id}
            <span class="indicator indicator-session">● Session</span>
          {/if}
          {#if server.current_command_id}
            <span class="indicator indicator-cmd">▶ Command</span>
          {/if}
        </div>

        <div class="server-actions" onclick={(e) => e.stopPropagation()} role="none">
          {#if server.current_session_id}
            <button
              class="btn btn-ghost btn-sm"
              onclick={(e) => quickKill(e, server)}
              id="kill-{server.id}"
              title="Kill active session"
            >
              ✕ Kill session
            </button>
          {:else}
            <button
              class="btn btn-ghost btn-sm"
              onclick={(e) => quickSession(e, server)}
              id="session-{server.id}"
              title="Start terminal session"
              disabled={server.status === 'archived'}
            >
              ⟳ Session
            </button>
          {/if}
          <button
            class="btn btn-ghost btn-sm"
            onclick={() => goto(`/servers/${server.id}`)}
            id="detail-{server.id}"
          >
            → Details
          </button>
        </div>
      </div>
    {/each}
  </div>
{/if}

<style>
  .loading-wrap {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    padding: var(--sp-8);
    justify-content: center;
  }

  .empty-state {
    text-align: center;
    padding: var(--sp-12) var(--sp-4);
    color: var(--text-secondary);
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
    align-items: center;
  }
  .empty-icon { font-size: 3rem; opacity: 0.2; }

  .server-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: var(--sp-4);
  }

  .server-card {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
    cursor: pointer;
  }

  .server-card-top { display: flex; flex-direction: column; gap: var(--sp-2); }

  .server-identity {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-3);
  }

  .server-name {
    font-weight: 500;
    font-size: var(--text-base);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .server-meta { letter-spacing: 0.02em; }

  .server-indicators {
    display: flex;
    gap: var(--sp-2);
    min-height: 20px;
  }
  .indicator {
    font-size: var(--text-xs);
    font-family: var(--font-mono);
    padding: 2px var(--sp-2);
    border-radius: 2px;
  }
  .indicator-session { background: var(--accent-blue-dim); color: var(--accent-blue); }
  .indicator-cmd     { background: var(--accent-purple-dim); color: var(--accent-purple); }

  .server-actions {
    display: flex;
    gap: var(--sp-2);
    justify-content: flex-end;
    padding-top: var(--sp-2);
    border-top: 1px solid var(--border);
    margin-top: auto;
  }
</style>
