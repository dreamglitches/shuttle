<script lang="ts">
  import { goto } from '$app/navigation';
  import { auth } from '$lib/api.js';
  import { authed, showToast } from '$lib/stores.js';

  let password = $state('');
  let loading = $state(false);
  let error = $state('');

  async function login(e: SubmitEvent) {
    e.preventDefault();
    if (!password) return;
    loading = true;
    error = '';
    try {
      await auth.login(password);
      authed.set(true);
      goto('/servers');
    } catch (err: unknown) {
      error = (err as { error: string }).error ?? 'Login failed';
    } finally {
      loading = false;
    }
  }
</script>

<svelte:head>
  <title>Shuttle — Login</title>
</svelte:head>

<div class="login-wrap">
  <div class="login-card">
    <div class="login-brand">
      <div class="login-icon" aria-hidden="true">⟳</div>
      <h1 class="login-title">Shuttle</h1>
      <p class="login-sub">Fleet terminal access</p>
    </div>

    <form onsubmit={login} class="login-form" novalidate>
      <div class="form-group">
        <label class="form-label" for="password-input">Password</label>
        <input
          id="password-input"
          class="input"
          type="password"
          bind:value={password}
          placeholder="Enter fleet password"
          autocomplete="current-password"
          required
          disabled={loading}
        />
      </div>

      {#if error}
        <div class="form-error" role="alert" aria-live="polite">{error}</div>
      {/if}

      <button
        id="login-btn"
        type="submit"
        class="btn btn-primary w-full"
        disabled={loading || !password}
      >
        {#if loading}
          <span class="spinner" aria-hidden="true"></span>
          Authenticating…
        {:else}
          Sign in
        {/if}
      </button>
    </form>

    <p class="login-note text-muted text-xs">
      Single operator access. Session expires in 24 hours.
    </p>
  </div>
</div>

<style>
  .login-wrap {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg-base);
    padding: var(--sp-4);
  }

  .login-card {
    width: 360px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: var(--sp-8);
    display: flex;
    flex-direction: column;
    gap: var(--sp-6);
  }

  .login-brand {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--sp-2);
    text-align: center;
  }

  .login-icon {
    font-size: 2rem;
    color: var(--text-primary);
    line-height: 1;
  }

  .login-title {
    font-size: var(--text-2xl);
    font-weight: 600;
    letter-spacing: -0.03em;
  }

  .login-sub {
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  .login-form {
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
  }

  .login-note {
    text-align: center;
  }
</style>
