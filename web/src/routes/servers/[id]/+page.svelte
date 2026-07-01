<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { servers as serversApi, actions as actionsApi } from '$lib/api.js';
  import type { Server, Action } from '$lib/api.js';
  import { showToast } from '$lib/stores.js';
  import StatusBadge from '$lib/components/StatusBadge.svelte';
  import ActionRow from '$lib/components/ActionRow.svelte';
  import OutputPane from '$lib/components/OutputPane.svelte';

  const serverId = $derived($page.params.id);

  let server = $state<Server | null>(null);
  let history = $state<Action[]>([]);
  let runningAction = $state<Action | null>(null);
  let loading = $state(true);
  let cmdInput = $state('');
  let cmdTimeout = $state(0);
  let cmdLoading = $state(false);
  let renaming = $state(false);
  let renameValue = $state('');
  let confirmArchive = $state(false);
  let confirmDelete = $state(false);
  let outputPolling: ReturnType<typeof setInterval> | null = null;

  async function load() {
    try {
      const [s, acts] = await Promise.all([
        serversApi.get(serverId),
        actionsApi.list(serverId, { limit: 30 }),
      ]);
      server = s;
      history = acts;
      renameValue = s.name ?? '';
      // Find the currently running command action
      runningAction = acts.find(a =>
        a.type === 'execute_cmd' && ['running', 'acked', 'delivered', 'pending'].includes(a.status)
      ) ?? null;
    } catch {
      showToast('Failed to load server', 'error');
    } finally {
      loading = false;
    }
  }

  async function pollOutput() {
    if (!runningAction) return;
    try {
      const updated = await actionsApi.get(serverId, runningAction.id);
      runningAction = updated;
      // If finished, refresh everything
      if (['completed', 'failed', 'timed_out', 'stopped'].includes(updated.status)) {
        stopOutputPolling();
        await load();
      }
    } catch { /* ignore transient errors */ }
  }

  function startOutputPolling() {
    if (outputPolling) return;
    outputPolling = setInterval(pollOutput, 3000);
  }

  function stopOutputPolling() {
    if (outputPolling) { clearInterval(outputPolling); outputPolling = null; }
  }

  $effect(() => {
    if (runningAction && ['running', 'acked', 'delivered'].includes(runningAction.status)) {
      startOutputPolling();
    } else {
      stopOutputPolling();
    }
  });

  let refreshTimer: ReturnType<typeof setInterval>;
  onMount(() => {
    load();
    refreshTimer = setInterval(load, 30_000);
  });
  onDestroy(() => {
    clearInterval(refreshTimer);
    stopOutputPolling();
  });

  // ─── Actions ──────────────────────────────────────────────────────────────

  async function startSession() {
    try {
      const a = await actionsApi.createSession(serverId, false);
      showToast(`Session requested — ${a.id.slice(0, 8)}`, 'success');
      await load();
    } catch (e: unknown) { showToast((e as {error:string}).error ?? 'Failed', 'error'); }
  }

  async function killSession() {
    try {
      await actionsApi.killSession(serverId);
      showToast('Kill dispatched', 'success');
      await load();
    } catch (e: unknown) { showToast((e as {error:string}).error ?? 'Failed', 'error'); }
  }

  async function runCommand() {
    if (!cmdInput.trim()) return;
    cmdLoading = true;
    try {
      const a = await actionsApi.execCmd(serverId, cmdInput.trim(), cmdTimeout || undefined, false);
      showToast(`Command dispatched — ${a.id.slice(0, 8)}`, 'success');
      cmdInput = '';
      await load();
    } catch (e: unknown) { showToast((e as {error:string}).error ?? 'Failed', 'error'); }
    finally { cmdLoading = false; }
  }

  async function stopCommand() {
    if (!server?.current_command_id) return;
    try {
      await actionsApi.stopCmd(serverId, server.current_command_id);
      showToast('Stop dispatched', 'success');
      await load();
    } catch (e: unknown) { showToast((e as {error:string}).error ?? 'Failed', 'error'); }
  }

  async function saveRename() {
    if (!renameValue.trim()) return;
    try {
      await serversApi.rename(serverId, renameValue.trim());
      showToast('Renamed', 'success');
      renaming = false;
      await load();
    } catch (e: unknown) { showToast((e as {error:string}).error ?? 'Failed', 'error'); }
  }

  async function archiveServer() {
    try {
      await serversApi.archive(serverId);
      showToast('Server archived', 'success');
      goto('/servers');
    } catch (e: unknown) { showToast((e as {error:string}).error ?? 'Failed', 'error'); }
  }

  async function hardDeleteServer() {
    try {
      await serversApi.delete(serverId);
      showToast('Server deleted', 'success');
      goto('/servers');
    } catch (e: unknown) { showToast((e as {error:string}).error ?? 'Failed', 'error'); }
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
    showToast('Copied to clipboard', 'success');
  }

  function reltime(ts: number | null): string {
    if (!ts) return '—';
    const diff = Math.floor(Date.now() / 1000) - ts;
    if (diff < 60)    return `${diff}s ago`;
    if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }

  // Find the most recent completed session action with a link
  const latestSessionLink = $derived(
    history.find(a => a.type === 'create_session' && a.result?.session_link)?.result?.session_link
  );
</script>

<svelte:head>
  <title>Shuttle — {server?.name ?? server?.id?.slice(0,12) ?? 'Server'}</title>
</svelte:head>

<button class="btn btn-ghost btn-sm mb-4" onclick={() => goto('/servers')} id="back-btn">
  ← Servers
</button>

{#if loading}
  <div class="flex items-center gap-3" style="padding: var(--sp-8);">
    <span class="spinner"></span>
    <span class="text-muted text-sm">Loading…</span>
  </div>
{:else if server}
  <!-- Header -->
  <div class="page-header">
    <div class="server-header-left">
      {#if renaming}
        <div class="rename-form">
          <input
            id="rename-input"
            class="input"
            bind:value={renameValue}
            onkeydown={(e) => e.key === 'Enter' && saveRename()}
            style="font-size: var(--text-xl); font-weight: 600;"
          />
          <button class="btn btn-primary btn-sm" onclick={saveRename} id="save-rename-btn">Save</button>
          <button class="btn btn-ghost btn-sm" onclick={() => renaming = false} id="cancel-rename-btn">Cancel</button>
        </div>
      {:else}
        <div class="flex items-center gap-3">
          <h1 class="page-title">{server.name ?? server.id.slice(0, 16)}</h1>
          <StatusBadge status={server.status} />
          <button
            class="btn btn-ghost btn-sm"
            onclick={() => renaming = true}
            id="rename-btn"
            title="Rename server"
          >✎</button>
        </div>
      {/if}
      <div class="server-meta text-sm text-muted">
        <span class="mono">{server.id.slice(0, 24)}…</span>
        · {server.arch ?? '?'} · v{server.client_version ?? '?'}
        · Last seen {reltime(server.last_seen_at)}
        · {server.last_ip ?? '?'}
      </div>
    </div>

    <div class="server-header-actions flex gap-2">
      <button class="btn btn-ghost btn-sm" onclick={load} id="refresh-detail-btn">↻</button>
      {#if server.status !== 'archived'}
        <button class="btn btn-danger btn-sm" onclick={() => confirmArchive = true} id="archive-btn">
          Archive
        </button>
      {:else}
        <button class="btn btn-danger btn-sm" onclick={() => confirmDelete = true} id="delete-btn">
          Delete
        </button>
      {/if}
    </div>
  </div>

  <div class="detail-layout">
    <!-- Left column: session + command -->
    <div class="detail-main">

      <!-- Session panel -->
      <section class="card section">
        <h2 class="section-title">Terminal Session</h2>

        {#if server.current_session_id}
          <div class="session-active">
            <div class="flex items-center gap-3 mb-4">
              <span class="indicator-dot active"></span>
              <span class="text-sm text-green" style="font-weight: 500;">Session active</span>
              <span class="mono text-xs text-muted">{server.current_session_id.slice(0,12)}</span>
            </div>

            {#if latestSessionLink}
              <div class="ssh-link mb-4">
                <span style="flex: 1;">{latestSessionLink}</span>
                <button
                  class="btn btn-ghost btn-sm"
                  onclick={() => copyToClipboard(latestSessionLink)}
                  id="copy-ssh-btn"
                  title="Copy SSH command"
                >
                  Copy
                </button>
              </div>
            {/if}

            <button class="btn btn-danger btn-sm" onclick={killSession} id="kill-session-btn">
              ✕ Kill session
            </button>
          </div>
        {:else}
          <p class="text-muted text-sm mb-4">No active session. Start one to get a shell on this server.</p>
          <button
            class="btn btn-primary"
            onclick={startSession}
            id="start-session-btn"
            disabled={server.status === 'archived'}
          >
            ⟳ Start session
          </button>
        {/if}
      </section>

      <!-- Command execution panel -->
      <section class="card section">
        <h2 class="section-title">Execute Command</h2>

        {#if server.current_command_id && runningAction}
          <!-- In-flight command -->
          <div class="running-cmd">
            <div class="flex items-center gap-3 mb-4">
              <span class="indicator-dot running"></span>
              <span class="text-sm" style="color: var(--accent-purple); font-weight: 500;">
                Command running
              </span>
              <StatusBadge status={runningAction.status} pulse={runningAction.status === 'running'} />
            </div>
            {#if runningAction.payload?.cmd}
              <div class="output-pane" style="min-height:auto; margin-bottom: var(--sp-3);">
                <span class="text-muted">$</span> {runningAction.payload.cmd}
              </div>
            {/if}
            <OutputPane action={runningAction} label="Live output" />
            <div class="flex gap-2 mt-4">
              <button class="btn btn-danger btn-sm" onclick={stopCommand} id="stop-cmd-btn">
                ■ Stop
              </button>
            </div>
          </div>
        {:else}
          <!-- Command input -->
          <form
            onsubmit={(e) => { e.preventDefault(); runCommand(); }}
            class="cmd-form"
          >
            <div class="form-group">
              <label class="form-label" for="cmd-input">Command</label>
              <input
                id="cmd-input"
                class="input input-mono"
                bind:value={cmdInput}
                placeholder="e.g. df -h"
                disabled={cmdLoading || server.status === 'archived'}
                autocomplete="off"
              />
            </div>
            <div class="cmd-options">
              <div class="form-group" style="flex: 0 0 140px;">
                <label class="form-label" for="cmd-timeout">Timeout (s)</label>
                <input
                  id="cmd-timeout"
                  class="input"
                  type="number"
                  min="0"
                  bind:value={cmdTimeout}
                  placeholder="0 = none"
                />
              </div>
              <button
                type="submit"
                class="btn btn-primary"
                id="run-cmd-btn"
                disabled={cmdLoading || !cmdInput.trim() || server.status === 'archived'}
                style="align-self: flex-end;"
              >
                {#if cmdLoading}
                  <span class="spinner"></span> Dispatching…
                {:else}
                  ▶ Run
                {/if}
              </button>
            </div>
          </form>
        {/if}
      </section>
    </div>

    <!-- Right column: info + history -->
    <div class="detail-sidebar">
      <!-- Server info -->
      <section class="card section">
        <h2 class="section-title">Info</h2>
        <dl class="info-list">
          <dt>ID</dt>       <dd class="mono">{server.id.slice(0,24)}</dd>
          <dt>Arch</dt>     <dd>{server.arch ?? '—'}</dd>
          <dt>Version</dt>  <dd class="mono">{server.client_version ?? '—'}</dd>
          <dt>Last IP</dt>  <dd class="mono">{server.last_ip ?? '—'}</dd>
          <dt>First seen</dt><dd>{reltime(server.first_seen_at)}</dd>
          <dt>Last seen</dt><dd>{reltime(server.last_seen_at)}</dd>
        </dl>
      </section>

      <!-- Action history -->
      <section class="card section" style="padding: 0; overflow: hidden;">
        <div class="section-header">
          <h2 class="section-title">Recent Actions</h2>
        </div>
        {#if history.length === 0}
          <p class="text-muted text-sm" style="padding: var(--sp-4);">No actions yet.</p>
        {:else}
          <div class="history-list">
            {#each history.slice(0, 20) as action (action.id)}
              <ActionRow {action} />
            {/each}
          </div>
        {/if}
      </section>
    </div>
  </div>
{/if}

<!-- Archive confirmation modal -->
{#if confirmArchive}
  <div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="archive-modal-title">
    <div class="modal">
      <h2 class="modal-title" id="archive-modal-title">Archive server?</h2>
      <p class="text-sm text-muted">
        The server will be hidden from the default list. You can still hard-delete it later.
        Existing action history is preserved.
      </p>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick={() => confirmArchive = false} id="cancel-archive-btn">Cancel</button>
        <button class="btn btn-danger" onclick={archiveServer} id="confirm-archive-btn">Archive</button>
      </div>
    </div>
  </div>
{/if}

<!-- Hard-delete confirmation modal -->
{#if confirmDelete}
  <div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="delete-modal-title">
    <div class="modal">
      <h2 class="modal-title" id="delete-modal-title">Permanently delete?</h2>
      <p class="text-sm text-muted">
        This permanently removes the server and all its action history. Cannot be undone.
      </p>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick={() => confirmDelete = false} id="cancel-delete-btn">Cancel</button>
        <button class="btn btn-danger" onclick={hardDeleteServer} id="confirm-delete-btn">Delete permanently</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .detail-layout {
    display: grid;
    grid-template-columns: 1fr 360px;
    gap: var(--sp-5);
    align-items: start;
  }
  @media (max-width: 900px) {
    .detail-layout { grid-template-columns: 1fr; }
  }

  .detail-main, .detail-sidebar {
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
  }

  .section { display: flex; flex-direction: column; gap: var(--sp-4); }
  .section-title {
    font-size: var(--text-sm);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }
  .section-header {
    padding: var(--sp-4);
    border-bottom: 1px solid var(--border);
  }

  .server-header-left { display: flex; flex-direction: column; gap: var(--sp-2); }
  .server-meta { font-family: var(--font-mono); }

  .rename-form { display: flex; align-items: center; gap: var(--sp-2); }

  .indicator-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .indicator-dot.active  { background: var(--accent-green); box-shadow: 0 0 6px var(--accent-green); }
  .indicator-dot.running { background: var(--accent-purple); animation: pulse 1.5s infinite; }

  .cmd-form { display: flex; flex-direction: column; gap: var(--sp-3); }
  .cmd-options { display: flex; gap: var(--sp-3); align-items: flex-end; }

  .info-list {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: var(--sp-1) var(--sp-4);
    font-size: var(--text-sm);
  }
  .info-list dt { color: var(--text-muted); white-space: nowrap; }
  .info-list dd { color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; }

  .history-list { max-height: 500px; overflow-y: auto; }
</style>
