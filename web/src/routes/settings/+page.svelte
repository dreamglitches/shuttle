<script lang="ts">
  import { onMount } from 'svelte';
  import { settings as settingsApi, telegram } from '$lib/api.js';
  import type { GlobalSettings } from '$lib/api.js';
  import { globalSettings, showToast } from '$lib/stores.js';
  import { auth } from '$lib/api.js';

  let gs = $state<GlobalSettings | null>(null);
  let loading = $state(true);
  let saving = $state(false);

  // Editable fields
  let form = $state<Partial<GlobalSettings>>({});

  // Telegram link
  let linkCode = $state('');
  let linkExpires = $state(0);
  let linkLoading = $state(false);

  // Change password
  let currentPw = $state('');
  let newPw = $state('');
  let pwLoading = $state(false);

  async function load() {
    try {
      const data = await settingsApi.getGlobal();
      gs = data.global;
      globalSettings.set(data.global);
      form = { ...data.global };
    } catch { showToast('Failed to load settings', 'error'); }
    finally { loading = false; }
  }

  onMount(load);

  async function saveSettings() {
    saving = true;
    try {
      // Only send changed values
      const updates: Partial<GlobalSettings> = {};
      if (gs && form) {
        for (const k of Object.keys(form) as (keyof GlobalSettings)[]) {
          if (form[k] !== gs[k]) {
            (updates as Record<string, unknown>)[k] = form[k];
          }
        }
      }
      if (Object.keys(updates).length === 0) {
        showToast('No changes to save', 'info');
        return;
      }
      await settingsApi.patchGlobal(updates);
      showToast('Settings saved', 'success');
      await load();
    } catch (e: unknown) { showToast((e as {error:string}).error ?? 'Failed', 'error'); }
    finally { saving = false; }
  }

  async function generateLink() {
    linkLoading = true;
    try {
      const res = await telegram.generateLink();
      linkCode = res.code;
      linkExpires = res.expires_in_seconds;
      showToast('Link code generated — send it to the bot with /link <code>', 'success');
    } catch (e: unknown) { showToast((e as {error:string}).error ?? 'Failed', 'error'); }
    finally { linkLoading = false; }
  }

  async function changePassword() {
    if (!currentPw || !newPw) return;
    if (newPw.length < 12) { showToast('Password must be at least 12 characters', 'error'); return; }
    pwLoading = true;
    try {
      await auth.changePassword(currentPw, newPw);
      showToast('Password changed', 'success');
      currentPw = ''; newPw = '';
    } catch (e: unknown) { showToast((e as {error:string}).error ?? 'Failed', 'error'); }
    finally { pwLoading = false; }
  }
</script>

<svelte:head>
  <title>Shuttle — Settings</title>
</svelte:head>

<div class="page-header">
  <h1 class="page-title">Settings</h1>
</div>

{#if loading}
  <div class="flex items-center gap-3" style="padding: var(--sp-8);">
    <span class="spinner"></span>
    <span class="text-muted text-sm">Loading…</span>
  </div>
{:else}
  <div class="settings-layout">

    <!-- Global fleet settings -->
    <section class="card settings-section">
      <h2 class="section-title">Fleet Settings</h2>
      <p class="text-muted text-sm">
        Propagated to all clients on their next beacon. Per-server overrides available on the server detail page.
      </p>

      <div class="settings-grid">
        <div class="form-group">
          <label class="form-label" for="poll-interval">Poll interval (seconds)</label>
          <input
            id="poll-interval"
            class="input"
            type="number"
            min="10"
            max="3600"
            bind:value={form.poll_interval}
          />
          <p class="form-hint">How often clients beacon. Default: 60</p>
        </div>

        <div class="form-group">
          <label class="form-label" for="upterm-relay">Upterm relay address</label>
          <input
            id="upterm-relay"
            class="input input-mono"
            bind:value={form.upterm_relay}
            placeholder="ssh.uptermd.dev:22"
          />
          <p class="form-hint">Public relay or your own uptermd instance</p>
        </div>

        <div class="form-group" style="grid-column: 1 / -1;">
          <label class="form-label" for="authorized-keys">Authorized keys (SSH public keys)</label>
          <textarea
            id="authorized-keys"
            class="input input-mono"
            rows="4"
            bind:value={form.authorized_keys}
            placeholder="ssh-ed25519 AAAA..."
            style="resize: vertical;"
          ></textarea>
          <p class="form-hint">One key per line. These are passed to upterm --authorized-keys on session start.</p>
        </div>

        <div class="form-group">
          <label class="form-label" for="output-cap">Output cap (KB)</label>
          <input id="output-cap" class="input" type="number" min="1" max="10240" bind:value={form.output_cap_kb} />
          <p class="form-hint">Max stored output per command. Default: 512</p>
        </div>

        <div class="form-group">
          <label class="form-label" for="retention-days">Retention (days)</label>
          <input id="retention-days" class="input" type="number" min="1" max="365" bind:value={form.retention_days} />
          <p class="form-hint">Completed action history purge window. Default: 30</p>
        </div>

        <div class="form-group">
          <label class="form-label" for="mgr-primary">Manager primary URL</label>
          <input id="mgr-primary" class="input input-mono" bind:value={form.manager_primary_url} placeholder="https://..." />
          <p class="form-hint">Clients will use this URL. Set to migrate manager endpoints.</p>
        </div>

        <div class="form-group">
          <label class="form-label" for="mgr-fallback">Manager fallback URL</label>
          <input id="mgr-fallback" class="input input-mono" bind:value={form.manager_fallback_url} placeholder="https://..." />
          <p class="form-hint">Tried when primary is unreachable</p>
        </div>
      </div>

      <div class="flex justify-end mt-4">
        <button class="btn btn-primary" onclick={saveSettings} id="save-settings-btn" disabled={saving}>
          {#if saving}<span class="spinner"></span>{/if}
          Save changes
        </button>
      </div>
    </section>

    <!-- Telegram integration -->
    <section class="card settings-section">
      <h2 class="section-title">Telegram Bot</h2>
      <p class="text-muted text-sm">
        Link your Telegram account to enable bot management and notifications.
        The bot silently ignores messages from any other account.
      </p>

      <div class="link-flow">
        <ol class="link-steps">
          <li>Start a chat with your bot on Telegram</li>
          <li>Click <b>Generate code</b> below</li>
          <li>Send <code>/link &lt;code&gt;</code> to the bot within 10 minutes</li>
        </ol>

        {#if linkCode}
          <div class="link-code-display">
            <span class="text-xs text-muted">Link code (expires in {linkExpires}s)</span>
            <div class="ssh-link" style="justify-content: space-between;">
              <code style="letter-spacing: 0.1em;">{linkCode}</code>
              <button class="btn btn-ghost btn-sm" onclick={() => navigator.clipboard.writeText(`/link ${linkCode}`)} id="copy-link-btn">
                Copy /link command
              </button>
            </div>
          </div>
        {/if}

        <button class="btn btn-ghost" onclick={generateLink} id="gen-link-btn" disabled={linkLoading}>
          {#if linkLoading}<span class="spinner"></span>{/if}
          Generate code
        </button>
      </div>
    </section>

    <!-- Change password -->
    <section class="card settings-section">
      <h2 class="section-title">Change Password</h2>
      <p class="text-muted text-sm">
        This password protects web dashboard access to your entire fleet. Use a strong, unique password.
        Minimum 12 characters.
      </p>

      <div class="settings-grid" style="grid-template-columns: 1fr 1fr;">
        <div class="form-group">
          <label class="form-label" for="current-pw">Current password</label>
          <input id="current-pw" class="input" type="password" bind:value={currentPw} autocomplete="current-password" />
        </div>
        <div class="form-group">
          <label class="form-label" for="new-pw">New password</label>
          <input id="new-pw" class="input" type="password" bind:value={newPw} autocomplete="new-password" />
          {#if newPw && newPw.length < 12}
            <p class="form-error">Must be at least 12 characters</p>
          {/if}
        </div>
      </div>

      <div class="flex justify-end">
        <button
          class="btn btn-primary"
          onclick={changePassword}
          id="change-pw-btn"
          disabled={pwLoading || !currentPw || !newPw || newPw.length < 12}
        >
          {#if pwLoading}<span class="spinner"></span>{/if}
          Change password
        </button>
      </div>
    </section>
  </div>
{/if}

<style>
  .settings-layout {
    display: flex;
    flex-direction: column;
    gap: var(--sp-5);
    max-width: 800px;
  }

  .settings-section {
    display: flex;
    flex-direction: column;
    gap: var(--sp-5);
  }

  .section-title {
    font-size: var(--text-sm);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }

  .settings-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--sp-4);
  }
  @media (max-width: 600px) {
    .settings-grid { grid-template-columns: 1fr; }
  }

  .link-flow { display: flex; flex-direction: column; gap: var(--sp-4); }
  .link-steps {
    padding-left: var(--sp-4);
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }
  .link-code-display { display: flex; flex-direction: column; gap: var(--sp-2); }
</style>
