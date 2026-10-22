<script setup lang="ts">
import { onMounted, ref } from "vue";

const apiStatus = ref("正在检查 API…");

onMounted(async () => {
  try {
    const response = await fetch("/api/health");
    apiStatus.value = response.ok ? "API 可用" : "API 暂不可用";
  } catch {
    apiStatus.value = "API 暂不可用";
  }
});
</script>

<template>
  <main>
    <p class="eyebrow">P0-1 · 项目基础</p>
    <h1>云族谱</h1>
    <p>项目基础已初始化；人物、谱书和世系功能将在后续 P0 阶段实现。</p>
    <p class="status" aria-live="polite">{{ apiStatus }}</p>
  </main>
</template>
