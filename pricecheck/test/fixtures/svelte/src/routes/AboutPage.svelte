<script>
  import Team from '../lib/Team.svelte'
  export let signedIn = false
</script>

<h1>About Example Hub</h1>
<p>We make small tools for busy teams.</p>
{#if signedIn}
  <button>Open workspace</button>
  <button>Sign out</button>
{:else}
  <button>Sign in</button>
{/if}
<Team />

<style>
  h1 { color: red; }
</style>
