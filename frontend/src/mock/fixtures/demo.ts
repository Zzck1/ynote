/**
 * Mock 演示数据（content-plan.md §7.1–7.3 三条，覆盖全成功 / partial+图集不可用 / 图文无视频 三种形态）。
 * 文案一律原样取自 content-plan，禁止自创界面文案。
 */

export interface DemoSpec {
  key: 'bilibili' | 'douyin' | 'xiaohongshu' | 'generic' | 'local'
  title: string
  author: string
  duration: number | null
  contentType: 'video' | 'image_post' | 'audio' | 'local_file'
  /** 封面占位图尺寸 [w,h]（程序生成 SVG，禁止做成真实播放器皮肤） */
  coverDims: [number, number] | null
  /** 图片资产尺寸与数量（图集保持原顺序） */
  images: { count: number; dims: [number, number] } | null
  /** 是否存在可确认的无水印源（演示「优先无水印」回退与「仅无水印」跳过） */
  cleanVideoSource: boolean
  /** 原文来源 */
  transcriptSource: 'subtitle' | 'asr' | 'post_text' | 'imported'
  coverage: number
  failedRanges: Array<{ start_ms: number; end_ms: number }>
  segments: string[]
  note: string
  /** 各能力是否可用；不可用必须给 reason（content-plan §2.2 不可用列） */
  unavailable: Partial<Record<'cover' | 'transcript' | 'video' | 'images' | 'audio', string>>
  /** 创建时间偏移（ms，相对 mock 库初始化时刻），对应 content-plan 相对时间示例 */
  ageMs: number
}

export const BILIBILI_NOTE = `# 一次讲透 React 19 的 use Hook

## 核心结论

\`use\` 是 React 19 引入的新 API，与 \`useState\`、\`useEffect\` 不同，它可以在条件语句和循环中调用，用于在渲染时读取 Promise 或 Context 的值。

> 原文 03:12：「use 的第一个特点是可以在条件分支里调用，这是以往所有 Hook 都做不到的。」

## 三个使用场景

1. **读取异步数据**：配合 Suspense，\`use(promise)\` 在数据就绪前挂起组件。
2. **条件性读取 Context**：根据运行时条件选择读取哪个 Context。
3. **与 Server Component 衔接**：服务端传来的 Promise 直接在客户端消费。

> 原文 11:45：「注意，同一个 Promise 不要传给两个组件，否则第二次读取会抛错——要传就用缓存后的同一个实例。」

## 常见坑位

- 在渲染期间创建新 Promise 会导致无限循环
- \`use\` 之后必须紧跟 Suspense 边界，否则报错

---

*基于原文（字幕）生成 · 覆盖率 99% · 生成于 3 天前*`

export const DOUYIN_NOTE = `# 手机拍出电影感转场的 3 个手部动作

## 要点速览

1. **遮挡切换**：手掌从镜头前横扫，遮住画面的瞬间切换场景
2. **跟随甩镜**：手机快速甩向一侧，下一镜头从同方向甩入
3. **推近定格**：快速推近到主体特写，下一场景从特写拉远开场

> 原文 00:08：「记住一个原则：转场不是后期加特效，是拍摄时就把动作做进去。」

## 拍摄参数

- 快门优先，跟随甩镜时快门不低于 1/120s
- 两个镜头的运动方向要一致，观感才连贯

---

*基于原文（转写）生成 · 覆盖率 100% · 生成于昨天*`

export const XHS_NOTE = `# 上海梧桐区一日步行路线

## 路线总览

武康路 → 五原路 → 安福路 → 巨鹿路，全程约 4.5 公里，步行加拍照大约 6 小时，适合上午 10 点出发。

> 原文 · 第 2 段：「五原路的小店十点半以后才陆续开门，去早了只能拍到卷帘门。」

## 8 个点位与花费

| 点位 | 建议停留 | 人均消费 |
|---|---|---|
| 武康大楼 | 20 分钟拍照 | 免费 |
| 五原路面包店 | 早餐 | ¥35 |
| 安福路话剧艺术中心 | 30 分钟 | ¥80（下午场） |
| …… | …… | …… |

> 原文 · 第 5 段：「胶片党注意：巨鹿路那家冲扫店下午四点截件，想当天拿到片子要赶早。」

---

*基于原文（帖子正文）生成 · 生成于 5 小时前*`

const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000

export const DEMO_SPECS: DemoSpec[] = [
  {
    key: 'bilibili',
    title: '一次讲透 React 19 的 use Hook：从源码示例到三个实战场景',
    author: '前端夜谈',
    duration: 1457, // 24:17
    contentType: 'video',
    coverDims: [1920, 1080],
    images: { count: 3, dims: [1920, 1080] },
    cleanVideoSource: true,
    transcriptSource: 'subtitle',
    coverage: 0.99,
    failedRanges: [{ start_ms: 80000, end_ms: 95000 }],
    segments: [
      '大家好，这里是前端夜谈。今天用一期视频把 React 19 新引入的 use Hook 讲透，从源码示例讲到三个实战场景。',
      '先说结论：use 是 React 19 引入的新 API，它和 useState、useEffect 完全不同，可以在条件语句和循环中调用。',
      'use 的第一个特点是可以在条件分支里调用，这是以往所有 Hook 都做不到的。',
      '第二个特点：use 读取的是一个 Promise 或者 Context 的值，它让「渲染时读取异步数据」变成了一件合法的事。',
      '第一个实战场景：读取异步数据。配合 Suspense，use(promise) 在数据就绪前挂起组件，Suspense 的 fallback 就是加载态。',
      '这里有个细节，同一个 Promise 不要传给两个组件，否则第二次读取会抛错——要传就用缓存后的同一个实例。',
      '第二个场景：条件性读取 Context。运行时先判断状态，再决定读哪个 Context，代码比层层.Consumer 干净很多。',
      '注意，同一个 Promise 不要传给两个组件，否则第二次读取会抛错——要传就用缓存后的同一个实例。这里再强调一次，因为翻车的人最多。',
      '第三个场景：与 Server Component 衔接。服务端传来的 Promise 直接在客户端消费，React 内部会保证只 resolve 一次。',
      '下面讲常见坑位。第一个坑：在渲染期间创建新 Promise 会导致无限循环，每次渲染都是新的 Promise，Suspense 永远等不到就绪。',
      '正确的做法是把 Promise 创建挪到事件处理器或者 useMemo 里，保证引用稳定。',
      '第二个坑：use 之后必须紧跟 Suspense 边界，否则 React 会直接报错，告诉你缺少捕获异步值的组件。',
      '有同学问 use 能不能替代 useEffect 请求数据——不能，它们的语义不一样，use 是「渲染时读取」，useEffect 是「提交后副作用」。',
      '再看一个源码层面的细节：use 在 React 内部通过享元模式缓存读取结果，避免重复 unwrap，这也是它能放进条件分支的原因。',
      '对比一下旧方案：以前要靠第三方库 suspend-react 做的事，现在是一等公民 API，类型推导也更好。',
      '关于错误处理：use 读取的 Promise 如果 reject，错误会抛给最近的 ErrorBoundary，记得在组件树上预留边界。',
      '实践建议一：数据请求层收敛到统一客户端，组件里只 use，不要在视图组件里散落 fetch。',
      '实践建议二：过渡动画用 useTransition 包一层，避免 Suspense 替换整棵子树的观感突兀。',
      '最后总结三个要点：一，use 可以条件调用；二，它配合 Suspense 和 ErrorBoundary 使用；三，Promise 引用必须稳定。',
      '这期就到这里，下期讲 React 19 的另一个新特性 Action。我们下期见。', // 20 段
    ],
    note: BILIBILI_NOTE,
    unavailable: {},
    ageMs: 3 * DAY,
  },
  {
    key: 'douyin',
    title: '30 秒学会：手机拍出电影感转场的 3 个手部动作',
    author: '阿茂的镜头日记',
    duration: 32, // 00:32
    contentType: 'video',
    coverDims: [1080, 1920],
    images: null,
    cleanVideoSource: false, // 演示「优先无水印」回退与「仅无水印」跳过
    transcriptSource: 'asr',
    coverage: 1,
    failedRanges: [],
    segments: [
      '三个手部动作，让你手机拍出电影感转场，最后一个最简单。',
      '记住一个原则：转场不是后期加特效，是拍摄时就把动作做进去。',
      '第一个动作，遮挡切换：手掌从镜头前横扫，遮住画面的瞬间切换场景。',
      '第二个动作，跟随甩镜：手机快速甩向一侧，下一镜头从同方向甩入，运动方向要一致。',
      '第三个动作，推近定格：快速推近到主体特写，下一场景从特写拉远开场。快门优先，甩镜时快门不低于 1/120s。',
    ],
    note: DOUYIN_NOTE,
    unavailable: {
      images: '该作品没有图集，可改为提取关键帧',
    },
    ageMs: 20 * HOUR, // 「昨天」
  },
  {
    key: 'xiaohongshu',
    title: '上海梧桐区一日步行路线：8 个点位、人均 150 拍完一卷胶片',
    author: '胶片不NG',
    duration: null, // 图文，无时长字段
    contentType: 'image_post',
    coverDims: [1280, 1707],
    images: { count: 8, dims: [1280, 1707] },
    cleanVideoSource: false,
    transcriptSource: 'post_text',
    coverage: 1,
    failedRanges: [],
    segments: [
      '武康路 → 五原路 → 安福路 → 巨鹿路，全程约 4.5 公里，步行加拍照大约 6 小时，适合上午 10 点出发。',
      '五原路的小店十点半以后才陆续开门，去早了只能拍到卷帘门。',
      '武康大楼是第一站，建议停留 20 分钟拍照，免费。早晨光线从衡山路方向打过来，正面拍最通透。',
      '五原路面包店解决早餐，人均 35，坐在窗边拍卷帘门半开的样子很有生活气。',
      '安福路话剧艺术中心下午场人均 80，门口的梧桐影子是整条街最好拍的机位。',
      '胶片党注意：巨鹿路那家冲扫店下午四点截件，想当天拿到片子要赶早。',
    ],
    note: XHS_NOTE,
    unavailable: {
      video: '该作品是图文帖子，没有视频',
      audio: '该作品没有可提取的音轨',
    },
    ageMs: 5 * HOUR, // 「5 小时前」
  },
  {
    key: 'generic',
    title: '未收录的演示视频（Mock 通用样例）',
    author: '演示作者',
    duration: 180,
    contentType: 'video',
    coverDims: [1920, 1080],
    images: null,
    cleanVideoSource: true,
    transcriptSource: 'asr',
    coverage: 1,
    failedRanges: [],
    segments: [
      '这是一段用于通用平台的演示文案，第一段介绍本期内容。',
      '第二段展开讲解主要观点，并给出两个论据。',
      '第三段做总结，并提示下期内容。',
    ],
    note: '# 演示笔记\n\n这是一份按通用平台元数据生成的结构化演示笔记。\n\n- 要点一\n- 要点二\n\n> 原文 · 第 1 段：「这是一段用于通用平台的演示文案，第一段介绍本期内容。」\n\n---\n\n*基于原文（转写）生成 · 覆盖率 100%*',
    unavailable: {
      images: '该作品没有图集，可改为提取关键帧',
    },
    ageMs: HOUR,
  },
  {
    key: 'local',
    title: '本地导入的演示文件',
    author: '本地导入',
    duration: null,
    contentType: 'local_file',
    coverDims: null, // 演示「取帧生成封面」兜底
    images: null,
    cleanVideoSource: true,
    transcriptSource: 'imported',
    coverage: 1,
    failedRanges: [],
    segments: [
      '这是本地导入文件后转写出的第一段演示文本。',
      '第二段：导入的素材同样可以生成 AI 笔记、思维导图和问答。',
    ],
    note: '# 本地导入演示笔记\n\n本地导入的素材走同一套笔记流程。\n\n> 原文 · 第 1 段：「这是本地导入文件后转写出的第一段演示文本。」\n\n---\n\n*基于原文（导入文本）生成 · 覆盖率 100%*',
    unavailable: {
      images: '该作品没有图集，可改为提取关键帧',
    },
    ageMs: 0,
  },
]

export const DEMO_SPEC_BY_KEY: Record<DemoSpec['key'], DemoSpec> = DEMO_SPECS.reduce(
  (acc, s) => {
    acc[s.key] = s
    return acc
  },
  {} as Record<DemoSpec['key'], DemoSpec>,
)
