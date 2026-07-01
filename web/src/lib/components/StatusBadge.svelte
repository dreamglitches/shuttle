<script lang="ts">
  import type { ActionStatus, Server } from '$lib/api.js';

  export let status: ActionStatus | Server['status'];
  export let pulse = false;

  const labels: Record<string, string> = {
    active: 'active', stale: 'stale', archived: 'archived',
    pending: 'pending', delivered: 'delivered', acked: 'acked',
    running: 'running', completed: 'done', failed: 'failed',
    timed_out: 'timeout', stopped: 'stopped',
  };
</script>

<span class="badge badge-{status}" class:pulse>
  {labels[status] ?? status}
</span>

<style>
  .pulse::before { animation: pulse 1.5s infinite; }
</style>
