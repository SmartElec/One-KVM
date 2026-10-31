import { computed, nextTick, ref, watch } from 'vue'
import type { CSSProperties, Ref } from 'vue'
import { useElementSize } from '@vueuse/core'

export type VideoScaleMode = 'fit' | 'actual'
export type VideoRotation = 0 | 90 | 180 | 270

export interface VideoSize {
  width: number
  height: number
}

/** 帧内实际内容区（归一化，0..1）；采集卡给非 16:9 信号补的黑边不算内容 */
export interface CropRect {
  left: number
  top: number
  right: number
  bottom: number
}

// 记住上一帧的分辨率：刷新页面时先用它铺好画面尺寸，
// 避免等首帧期间先出现一整块撑满工作区的黑框再突然缩回。
const SIZE_STORAGE_KEY = 'kvmLastSourceSize'

function readStoredSize(): VideoSize | null {
  try {
    const raw = sessionStorage.getItem(SIZE_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<VideoSize> | null
    if (!parsed || !Number.isFinite(parsed.width) || !Number.isFinite(parsed.height)) return null
    const width = Math.round(parsed.width as number)
    const height = Math.round(parsed.height as number)
    return width > 0 && height > 0 ? { width, height } : null
  } catch {
    return null
  }
}

function storeSize(size: VideoSize) {
  try {
    sessionStorage.setItem(SIZE_STORAGE_KEY, JSON.stringify(size))
  } catch {
    // sessionStorage 不可用时忽略，仅影响刷新后的首屏尺寸
  }
}

export function useVideoScaling(options: { rotation?: Readonly<Ref<VideoRotation>> } = {}) {
  const workspaceRef = ref<HTMLDivElement | null>(null)
  const scaleMode = ref<VideoScaleMode>('fit')
  const sourceSize = ref<VideoSize | null>(readStoredSize())
  const rotation = options.rotation ?? ref<VideoRotation>(0)
  const { width: workspaceWidth, height: workspaceHeight } = useElementSize(workspaceRef)

  const sourceSizeAvailable = computed(() => sourceSize.value !== null)
  const effectiveScaleMode = computed<VideoScaleMode>(() => (
    scaleMode.value === 'actual' && sourceSizeAvailable.value ? 'actual' : 'fit'
  ))

  const cropRect = ref<CropRect | null>(null)
  const hasQuarterTurn = computed(() => rotation.value === 90 || rotation.value === 270)
  // 旋转时坐标系不一致，直接不裁剪
  const activeCrop = computed(() => (hasQuarterTurn.value ? null : cropRect.value))
  const rotatedSourceSize = computed<VideoSize | null>(() => {
    const source = sourceSize.value
    if (!source) return null

    return hasQuarterTurn.value
      ? { width: source.height, height: source.width }
      : source
  })

  // 裁剪后实际显示的尺寸（用内容区占整帧的比例换算）
  const croppedSourceSize = computed<VideoSize | null>(() => {
    const source = rotatedSourceSize.value
    const crop = activeCrop.value
    if (!source || !crop) return null
    const width = source.width * (crop.right - crop.left)
    const height = source.height * (crop.bottom - crop.top)
    if (!(width >= 16 && height >= 16)) return null
    return { width: Math.round(width), height: Math.round(height) }
  })
  const effectiveSourceSize = computed<VideoSize | null>(() => croppedSourceSize.value ?? rotatedSourceSize.value)

  const fittedSize = computed<VideoSize | null>(() => {
    const source = effectiveSourceSize.value
    if (!source || workspaceWidth.value <= 0 || workspaceHeight.value <= 0) return null

    const scale = Math.min(
      workspaceWidth.value / source.width,
      workspaceHeight.value / source.height,
    )
    return {
      width: Math.max(1, Math.floor(source.width * scale)),
      height: Math.max(1, Math.floor(source.height * scale)),
    }
  })

  const stageClass = computed(() => effectiveScaleMode.value === 'actual'
    ? 'h-max w-max min-h-full min-w-full'
    : 'h-full w-full'
  )

  const containerStyle = computed<CSSProperties>(() => {
    const size = effectiveScaleMode.value === 'actual' ? effectiveSourceSize.value : fittedSize.value
    if (size) {
      return {
        width: `${size.width}px`,
        height: `${size.height}px`,
      }
    }

    return {
      width: '100%',
      height: '100%',
      minHeight: '120px',
    }
  })

  // A quarter turn swaps the displayed dimensions. Keep the video itself at
  // its unrotated dimensions, then rotate it inside the correctly sized frame.
  const contentStyle = computed<CSSProperties>(() => {
    const size = effectiveScaleMode.value === 'actual' ? effectiveSourceSize.value : fittedSize.value
    const quarterTurn = hasQuarterTurn.value

    return {
      width: size ? `${quarterTurn ? size.height : size.width}px` : '100%',
      height: size ? `${quarterTurn ? size.width : size.height}px` : '100%',
      transform: `rotate(${rotation.value}deg)`,
    }
  })

  // 媒体元素按内容区放大并偏移，父级 overflow 裁掉黑边
  const mediaStyle = computed<CSSProperties>(() => {
    const crop = activeCrop.value
    if (!crop) return {}
    const width = crop.right - crop.left
    const height = crop.bottom - crop.top
    if (width <= 0 || height <= 0) return {}
    return {
      position: 'absolute',
      left: '0',
      top: '0',
      maxWidth: 'none',
      maxHeight: 'none',
      width: `${100 / width}%`,
      height: `${100 / height}%`,
      transform: `translate(${-crop.left * 100}%, ${-crop.top * 100}%)`,
    }
  })

  function setCropRect(rect: CropRect | null) {
    cropRect.value = rect
  }

  function updateSourceSize(width: number, height: number) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return

    const nextSize = { width: Math.round(width), height: Math.round(height) }
    if (sourceSize.value?.width === nextSize.width && sourceSize.value.height === nextSize.height) return
    sourceSize.value = nextSize
    storeSize(nextSize)
  }

  function clearSourceSize() {
    sourceSize.value = null
  }

  function setScaleMode(mode: VideoScaleMode) {
    if (mode === 'actual' && !sourceSizeAvailable.value) return
    scaleMode.value = mode
  }

  watch(
    [effectiveScaleMode, () => sourceSize.value?.width, () => sourceSize.value?.height],
    async ([mode]) => {
      if (mode !== 'actual') return
      await nextTick()
      workspaceRef.value?.scrollTo({ left: 0, top: 0 })
    },
  )

  return {
    workspaceRef,
    scaleMode,
    sourceSize,
    sourceSizeAvailable,
    cropRect,
    setCropRect,
    mediaStyle,
    stageClass,
    containerStyle,
    contentStyle,
    updateSourceSize,
    clearSourceSize,
    setScaleMode,
  }
}
