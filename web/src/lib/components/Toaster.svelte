<script lang="ts">
  import { toasts } from '$lib/stores.js';
</script>

<div class="toast-container" aria-live="polite">
  {#each $toasts as toast (toast.id)}
    <div class="toast {toast.type}" role="alert">
      {toast.message}
    </div>
  {/each}
</div>
