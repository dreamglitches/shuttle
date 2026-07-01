<script lang="ts">
  import type { Action } from '$lib/api.js';

  export let action: Action | null;
  export let label = 'Output';
  export let maxHeight = '360px';

  $: output = action?.result?.output ?? '';
  $: truncated = action?.result?.truncated ?? false;
  $: isEmpty = !output;

  function copyOutput() {
    if (output) navigator.clipboard.writeText(output);
  }
</script>

<div class="pane-wrapper">
  <div class="pane-header">
    <span class="text-xs text-muted" style="text-transform: uppercase; letter-spacing: 0.06em;">
      {label}
    </span>
    {#if output}
      <button class="btn btn-ghost btn-sm" on:click={copyOutput} id="copy-output-btn">
        Copy
      </button>
    {/if}
  </div>

  <div class="output-pane" style="max-height: {maxHeight}">
    {#if isEmpty}
      <span class="text-muted text-xs">No output yet.</span>
    {:else}
      {output}
      {#if truncated}
        <span class="truncated-marker">&#10;[output truncated — increase output_cap_kb in settings]</span>
      {/if}
    {/if}
  </div>
</div>

<style>
  .pane-wrapper { display: flex; flex-direction: column; gap: var(--sp-2); }
  .pane-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
</style>
