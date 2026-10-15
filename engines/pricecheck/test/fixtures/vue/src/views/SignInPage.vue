<template>
  <main class="sign-in">
    <h1>Welcome back</h1>
    <p>Sign in to continue to Example Hub.</p>
    <form>
      <input type="email" placeholder="Email" />
      <input type="password" placeholder="Password" />
      <button type="submit">Sign in</button>
    </form>
    <a href="/forgot">Forgot password</a>
    <div v-if="error">
      <p>Something went wrong</p>
      <button>Retry</button>
      <button>Cancel</button>
    </div>
    <div v-else>
      <p>Ready</p>
    </div>
    <ul>
      <li v-for="item in items" :key="item.id">{{ item.label }}</li>
    </ul>
    <p>{{ $t('signin.help') }}</p>
    <SignInFooterBar />
  </main>
</template>

<script setup lang="ts">
import SignInFooterBar from '@/components/SignInFooterBar.vue'
</script>
