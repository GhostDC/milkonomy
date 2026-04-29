<script lang="ts" setup>
import { useGreyAndColorWeakness } from "@@/composables/useGreyAndColorWeakness"
import { useTheme } from "@@/composables/useTheme"
import { onMounted, onUnmounted } from 'vue'
import { useGameStore } from './pinia/stores/game'
import en from "element-plus/es/locale/lang/en"
import zhCn from "element-plus/es/locale/lang/zh-cn"

const { initTheme } = useTheme()
const { initGreyAndColorWeakness } = useGreyAndColorWeakness()
const gameStore = useGameStore()
let timer: ReturnType<typeof setInterval>
// 初始化主题
initTheme()
// 初始化灰色模式和色弱模式
initGreyAndColorWeakness()

const { locale } = useI18n()
const elLocale = computed(() => {
  switch (locale.value) {
    case "en":
      return en
    case "zhCn":
      return zhCn
    default:
      return en
  }
})

onMounted(() => {
  // 每 3 秒自动拉取一次 Toolasha 内存中的最新价格
  timer = setInterval(() => {
    gameStore.syncToolasha()
  }, 3000)
})

onUnmounted(() => {
  // 组件销毁时清除定时器，防止内存泄漏
  if (timer) clearInterval(timer)
})
</script>

<template>
  <el-config-provider :locale="elLocale">
    <router-view />
  </el-config-provider>
</template>
