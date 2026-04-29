import type Calculator from "@/calculator"
import type { DecomposeCalculator } from "@/calculator/alchemy"
import type { EnhanceCalculator } from "@/calculator/enhance"
import type { ManufactureCalculator } from "@/calculator/manufacture"

import type { WorkflowCalculator } from "@/calculator/workflow"
import type { Action, GameData, NoncombatStatsKey } from "~/game"
import type { Market, MarketData, MarketDataPlain, MarketItemPrice } from "~/market"
import { defineStore } from "pinia"
import { getIndexedDbValue, setIndexedDbValue } from "@/common/utils/cache/indexed-db"
import locales, { getTrans } from "@/locales"
import { pinia } from "@/pinia"

// 基础常量置顶，防止打包后引发 TDZ 报错
const KEY_PREFIX = "game-"
const GAME_DATA_KEY = `${KEY_PREFIX}game-data`
const MARKET_DATA_KEY = `${KEY_PREFIX}market-data`

export const COIN_HRID = "/items/coin"

export const ACTION_LIST = [
  "milking",
  "foraging",
  "woodcutting",
  "cheesesmithing",
  "crafting",
  "tailoring",
  "cooking",
  "brewing",
  "alchemy",
  "enhancing"
] as const

export const EQUIPMENT_LIST = [
  "head",
  "body",
  "legs",
  "feet",
  "hands",

  "ring",
  "neck",
  "earrings",
  "back",
  "off_hand",
  "pouch",
  // 'main_hand'
  "charm"
] as const

export const COMMUNITY_BUFF_LIST = [
  "experience",
  "gathering_quantity",
  "production_efficiency",
  "enhancing_speed"
]

export const ACHIEVEMENT_TIER_LIST = [
  "beginner",
  "novice",
  "adept",
  "veteran",
  "elite",
  "champion"
] as const

const DEFAULT_HOUSE = {
  Efficiency: 0.015,
  Experience: 0.0005,
  RareFind: 0.002
}

export const HOUSE_MAP: Record<Action, Partial<Record<NoncombatStatsKey, number>>> = {
  milking: { ...DEFAULT_HOUSE },
  foraging: { ...DEFAULT_HOUSE },
  woodcutting: { ...DEFAULT_HOUSE },
  cheesesmithing: { ...DEFAULT_HOUSE },
  crafting: { ...DEFAULT_HOUSE },
  tailoring: { ...DEFAULT_HOUSE },
  brewing: { ...DEFAULT_HOUSE },
  cooking: { ...DEFAULT_HOUSE },
  alchemy: { ...DEFAULT_HOUSE },
  enhancing: {
    Speed: 0.01,
    Success: 0.0005,
    Experience: 0.0005,
    RareFind: 0.002
  }
}

export enum PriceStatus {
  // 左价
  ASK = "ASK",
  // 右价
  BID = "BID",
  // 比左价低一档
  ASK_LOW = "ASK_LOW",
  // 比右价高一档
  BID_HIGH = "BID_HIGH"
}

export const PRICE_STATUS_LIST = [
  { value: PriceStatus.ASK, label: getTrans("左价") },
  { value: PriceStatus.ASK_LOW, label: `${getTrans("左价")}-` },
  { value: PriceStatus.BID, label: getTrans("右价") },
  { value: PriceStatus.BID_HIGH, label: `${getTrans("右价")}+` }
]

export const useGameStore = defineStore("game", {
  state: () => ({
    gameData: null as GameData | null,
    marketData: null as MarketData | null,
    leaderboardCache: {} as { [key: string]: Calculator[] },
    enhanposerCache: {} as { [time: number]: WorkflowCalculator[] },
    manualchemyCache: {} as { [time: number]: Calculator[] },
    jungleCache: {} as { [key: string]: WorkflowCalculator[] },
    junglestCache: {} as { [time: number]: EnhanceCalculator[] },
    inheritCache: {} as { [time: number]: ManufactureCalculator[] },
    decomposeCache: {} as { [time: number]: DecomposeCalculator[] },
    secret: loadSecret(),
    buyStatus: loadBuyStatus(),
    sellStatus: loadSellStatus(),
    persistentDataHydrated: false
  }),
  actions: {
    async hydratePersistentData() {
      if (this.persistentDataHydrated) {
        return
      }

      const [gameData, marketData] = await Promise.all([
        getGameData(),
        getMarketData()
      ])

      this.gameData = gameData
      this.marketData = marketData
      this.persistentDataHydrated = true
      
      // 初始化时尝试拉取一次本地插件缓存
      this.syncToolasha()
    },
    async tryFetchData() {
      let retryCount = 5
      while (retryCount--) {
        try {
          await this.fetchData(retryCount)
          break
        } catch (e) {
          console.error(`获取数据第${5 - retryCount}次失败`, e)
          // 动态导入 ElMessage，彻底避开打包时的模块时序提前/死区崩溃问题
          import("element-plus").then(({ ElMessage }) => {
            ElMessage.error(locales.global.t("获取数据第{0}次失败，正在重试...", [5 - retryCount]))
          }).catch(console.error)
        }
      }
      if (this.gameData && this.marketData && retryCount === 0) {
        import("element-plus").then(({ ElMessage }) => {
          ElMessage.error(locales.global.t("数据获取失败，直接使用缓存数据"))
        }).catch(console.error)
        return
      }
      if (retryCount < 0) {
        import("element-plus").then(({ ElMessage }) => {
          ElMessage.error(locales.global.t("数据获取失败，请检查网络连接"))
        }).catch(console.error)
        throw new Error("强制宕机")
      }
    },
    async fetchData(offset: number) {
      const url = import.meta.env.MODE === "development" ? "/" : "./"
      const MARKET_URLS = [
        "https://www.milkywayidle.com/game_data/marketplace.json"
      ]
      const DATA_URL = `${url}data/data.json`
      const marketUrl = MARKET_URLS[(4 - offset) % MARKET_URLS.length]

      const response = await Promise.all([fetch(DATA_URL), fetch(marketUrl)])
      if (!response[0].ok || !response[1].ok) {
        throw new Error("Response not ok")
      }
      const newGameData = await response[0].json()
      const newMarketData = await response[1].json()
      
      const gameVersionChanged = !this.gameData
        || this.gameData.gameVersion !== newGameData.gameVersion
        || this.gameData.versionTimestamp !== newGameData.versionTimestamp
      if (gameVersionChanged) {
        this.gameData = newGameData
        this.clearAllCaches()
      }
      await setGameData(newGameData)

      const sameTimestamp = this.marketData?.timestamp && this.marketData?.timestamp === newMarketData.timestamp
      if (sameTimestamp && hasAvgVolFields(this.marketData)) {
        this.syncToolasha()
        return
      }

      this.marketData = await updateMarketData(this.marketData, newMarketData, newGameData)
      this.clearAllCaches()
    },

    syncToolasha() {
      if (!this.marketData || !this.marketData.marketData) return
      let hasChanges = false

      for (const hrid in this.marketData.marketData) {
        const levels = this.marketData.marketData[hrid]
        for (const level in levels) {
          const toolashaPrice = getToolashaMarketItem(hrid, level)
          if (toolashaPrice) {
            const price = levels[level]
            let itemChanged = false
            const oldAsk = price.ask
            const oldBid = price.bid

            if (toolashaPrice.ask > 0 && price.ask !== toolashaPrice.ask) {
              price.ask = toolashaPrice.ask
              itemChanged = true
              hasChanges = true
            }
            if (toolashaPrice.bid > 0 && price.bid !== toolashaPrice.bid) {
              price.bid = toolashaPrice.bid
              itemChanged = true
              hasChanges = true
            }

            if (itemChanged) {
              console.log(`[Toolasha 内存同步] 更新物品 ${hrid} (+${level}) | a: ${oldAsk} -> ${price.ask}, b: ${oldBid} -> ${price.bid}`)
            }
          }
        }
      }

      if (hasChanges) {
        setMarketData(this.marketData).catch(console.error)
        this.clearAllCaches()
      }
    },

    savePriceStatus() {
      this.clearAllCaches()
    },
    resetPriceStatus() {
      this.buyStatus = loadBuyStatus()
      this.sellStatus = loadSellStatus()
    },
    getLeaderboardCache(key?: string) {
      const cacheKey = key ?? String(this.marketData!.timestamp)
      return this.leaderboardCache[cacheKey]
    },
    setLeaderBoardCache(list: Calculator[], key?: string) {
      const cacheKey = key ?? String(this.marketData!.timestamp)
      this.leaderboardCache[cacheKey] = list
    },
    clearLeaderBoardCache(key?: string) {
      if (key) {
        delete this.leaderboardCache[key]
        return
      }
      this.leaderboardCache = {}
    },
    getEnhanposerCache() {
      return this.enhanposerCache[this.marketData!.timestamp]
    },
    setEnhanposerCache(list: WorkflowCalculator[]) {
      this.clearEnhanposerCache()
      this.enhanposerCache[this.marketData!.timestamp] = list
    },
    clearEnhanposerCache() {
      this.enhanposerCache = {}
    },
    getManualchemyCache() {
      return this.manualchemyCache[this.marketData!.timestamp]
    },
    setManualchemyCache(list: Calculator[]) {
      this.clearManualchemyCache()
      this.manualchemyCache[this.marketData!.timestamp] = list
    },
    clearManualchemyCache() {
      this.manualchemyCache = {}
    },
    getJungleCache(key: string) {
      return this.jungleCache[key]
    },
    setJungleCache(list: WorkflowCalculator[], key: string) {
      this.jungleCache[key] = list
    },
    clearJungleCache(key?: string) {
      if (key) {
        delete this.jungleCache[key]
      } else {
        this.jungleCache = {}
      }
    },
    getJunglestCache() {
      return this.junglestCache[this.marketData!.timestamp]
    },
    setJunglestCache(list: EnhanceCalculator[]) {
      this.clearJunglestCache()
      this.junglestCache[this.marketData!.timestamp] = list
    },
    clearJunglestCache() {
      this.junglestCache = {}
    },
    getInheritCache() {
      return this.inheritCache[this.marketData!.timestamp]
    },
    setInheritCache(list: ManufactureCalculator[]) {
      this.clearInheritCache()
      this.inheritCache[this.marketData!.timestamp] = list
    },
    clearInheritCache() {
      this.inheritCache = {}
    },
    getDecomposeCache() {
      return this.decomposeCache[this.marketData!.timestamp]
    },
    setDecomposeCache(list: DecomposeCalculator[]) {
      this.clearDecomposeCache()
      this.decomposeCache[this.marketData!.timestamp] = list
    },
    clearDecomposeCache() {
      this.decomposeCache = {}
    },
    setSecret(value: string) {
      this.secret = value
      saveSecret(value)
    },
    checkSecret() {
      return true
    },

    clearAllCaches() {
      this.clearLeaderBoardCache()
      this.clearManualchemyCache()
      this.clearInheritCache()
      this.clearDecomposeCache()
      this.clearEnhanposerCache()
      this.clearJungleCache()
      this.clearJunglestCache()
    }
  }
})

function hasAvgVolFields(data: MarketData | null | undefined) {
  const market = data?.marketData
  if (!market) return false
  for (const hrid in market) {
    const item = market[hrid]
    if (!item) continue
    for (const level in item) {
      const price: any = (item as any)[level]
      if (price && (Object.prototype.hasOwnProperty.call(price, "avg") || Object.prototype.hasOwnProperty.call(price, "vol"))) {
        return true
      }
    }
  }
  return false
}

async function updateMarketData(oldData: MarketData | null, newData: MarketDataPlain, newGameData: GameData): Promise<MarketData> {
  const oldMarket = oldData?.marketData || {}
  const newMarket: Market = { }

  for (const hrid in newData.marketData) {
    const levels = newData.marketData[hrid]
    if (!levels) continue
    newMarket[hrid] = {}
    for (const level in levels) {
      const plain = levels[level] || {}
      newMarket[hrid][level] = {
        ask: plain.a ?? -1,
        bid: plain.b ?? -1,
        avg: plain.p ?? -1,
        vol: plain.v ?? -1
      }
    }
  }

  const itemDetailMap = newGameData.itemDetailMap
  const isEquipmentMap: Record<string, boolean> = {}
  for (const key in itemDetailMap) {
    const item = itemDetailMap[key]
    isEquipmentMap[item.hrid] = item.categoryHrid === "/item_categories/equipment"
  }
  
  for (const hrid in newMarket) {
    if (isEquipmentMap[hrid] || oldMarket[hrid]) {
      continue
    }
    for (const level in newMarket[hrid]) {
      const price = newMarket[hrid][level]
      if (price.ask === -1) {
        price.ask = (oldMarket[hrid]?.[level] as MarketItemPrice)?.ask || -1
      }
      if (price.bid === -1) {
        price.bid = (oldMarket[hrid]?.[level] as MarketItemPrice)?.bid || -1
      }
      if ((price.avg ?? -1) === -1) {
        price.avg = (oldMarket[hrid]?.[level] as MarketItemPrice)?.avg ?? -1
      }
      if ((price.vol ?? -1) === -1) {
        price.vol = (oldMarket[hrid]?.[level] as MarketItemPrice)?.vol ?? -1
      }

      // 获取并合并 Toolasha 实时价格补丁，带日志打印
      const toolashaPrice = getToolashaMarketItem(hrid, level)
      if (toolashaPrice) {
        let updated = false
        const oldAsk = price.ask
        const oldBid = price.bid

        if (toolashaPrice.ask > 0 && price.ask !== toolashaPrice.ask) {
          price.ask = toolashaPrice.ask
          updated = true
        }
        if (toolashaPrice.bid > 0 && price.bid !== toolashaPrice.bid) {
          price.bid = toolashaPrice.bid
          updated = true
        }

        if (updated) {
          console.log(`[Toolasha 接口覆盖] 发现实时价覆盖 API 价 ${hrid} (+${level}) | a: ${oldAsk} -> ${price.ask}, b: ${oldBid} -> ${price.bid}`)
        }
      }
    }
  }

  const result = {
    timestamp: newData.timestamp,
    marketData: newMarket
  }
  await setMarketData(result)

  return result
}

function getToolashaMarketItem(hrid: string, level: string | number) {
  const toolasha = (window as any).Toolasha || (typeof (window as any).unsafeWindow !== 'undefined' ? (window as any).unsafeWindow.Toolasha : null)
  if (!toolasha || !toolasha.Core || !toolasha.Core.marketAPI) return null

  const marketAPI = toolasha.Core.marketAPI
  let ask = -1
  let bid = -1

  const patchKey = `${hrid}:${level}`
  const freshPatch = marketAPI.pricePatchs && marketAPI.pricePatchs[patchKey]

  if (freshPatch) {
    if (freshPatch.a !== undefined && freshPatch.a > 0) ask = freshPatch.a
    if (freshPatch.b !== undefined && freshPatch.b > 0) bid = freshPatch.b
  }

  if (ask === -1 && bid === -1 && marketAPI.marketData) {
    const itemData = marketAPI.marketData[hrid]
    if (itemData && itemData[String(level)]) {
      if (itemData[String(level)].a !== undefined && itemData[String(level)].a > 0) ask = itemData[String(level)].a
      if (itemData[String(level)].b !== undefined && itemData[String(level)].b > 0) bid = itemData[String(level)].b
    }
  }

  if (ask === -1 && bid === -1) return null
  return { ask, bid }
}

function readLegacyLocalStorageJson<T>(key: string): T | null {
  const raw = localStorage.getItem(key)
  if (!raw) {
    return null
  }
  return JSON.parse(raw) as T
}

async function getMarketData() {
  const cached = await getIndexedDbValue<MarketData>(MARKET_DATA_KEY)
  if (cached) {
    return cached
  }

  const legacy = readLegacyLocalStorageJson<MarketData>(MARKET_DATA_KEY)
  if (legacy) {
    await setIndexedDbValue(MARKET_DATA_KEY, legacy)
    localStorage.removeItem(MARKET_DATA_KEY)
  }
  return legacy
}

async function setMarketData(value: MarketData) {
  await setIndexedDbValue(MARKET_DATA_KEY, value)
  localStorage.removeItem(MARKET_DATA_KEY)
}

async function getGameData() {
  const cached = await getIndexedDbValue<GameData>(GAME_DATA_KEY)
  if (cached) {
    return cached
  }

  const legacy = readLegacyLocalStorageJson<GameData>(GAME_DATA_KEY)
  if (legacy) {
    await setIndexedDbValue(GAME_DATA_KEY, legacy)
    localStorage.removeItem(GAME_DATA_KEY)
  }
  return legacy
}

async function setGameData(value: GameData) {
  await setIndexedDbValue(GAME_DATA_KEY, value)
  localStorage.removeItem(GAME_DATA_KEY)
}

function loadSecret() {
  return localStorage.getItem(`${KEY_PREFIX}secrete`) || ""
}

function saveSecret(value: string) {
  localStorage.setItem(`${KEY_PREFIX}secrete`, value)
}

function loadBuyStatus() {
  return PriceStatus.ASK
}

function loadSellStatus() {
  return PriceStatus.BID
}

export function useGameStoreOutside() {
  return useGameStore(pinia)
}
