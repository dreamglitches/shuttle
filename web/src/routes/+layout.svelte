<script lang="ts">
  import type { Snippet } from 'svelte';
  import '../app.css';
  import Toaster from '$lib/components/Toaster.svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { authed } from '$lib/stores.js';
  import { auth } from '$lib/api.js';

  const navItems = [
    { href: '/servers',  label: 'Servers',  icon: '⧡' },
    { href: '/settings', label: 'Settings', icon: '⚙' },
  ];

  const isLogin = $derived($page.url.pathname === '/');

  let { children }: { children: Snippet } = $props();

  async function logout() {
    await auth.logout();
    authed.set(false);
    goto('/');
  }
</script>

{#if isLogin}
  {@render children()}
{:else}
  <div class="app-layout">
    <nav class="sidebar" aria-label="Main navigation">
      <div class="sidebar-logo">
        <span style="font-size: 1.2rem;">⟳</span>
        <span>Shuttle</span>
      </div>

      {#each navItems as item}
        <a
          href={item.href}
          class="nav-item"
          class:active={$page.url.pathname.startsWith(item.href)}
          aria-current={$page.url.pathname.startsWith(item.href) ? 'page' : undefined}
        >
          <span aria-hidden="true">{item.icon}</span>
          {item.label}
        </a>
      {/each}

      <div style="flex: 1;"></div>

      <button class="nav-item" style="margin-top: auto;" onclick={logout} id="logout-btn">
        <span aria-hidden="true">→</span>
        Log out
      </button>
    </nav>

    <main class="main-content">
      {@render children()}
    </main>
  </div>
{/if}

<Toaster />

<style>
  .sidebar {
    display: flex;
    flex-direction: column;
  }
</style>
