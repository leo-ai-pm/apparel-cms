/** Homepage prompts and existing seed SKU references; not a recommended outfit.
 * Product names, prices and availability must come from the real product API.
 * Local showcase images are byte-identical copies of existing authorized AI assets.
 */
export type ShowcaseTile = Readonly<{
  productId: string;
  label: string;
  background: string;
}>;

export type ShowcaseGroup = Readonly<{
  id: string;
  title: string;
  prompt: string;
  tiles: readonly [ShowcaseTile, ShowcaseTile, ShowcaseTile, ShowcaseTile];
}>;

export type ShowcaseChip = Readonly<{
  id: string;
  title: string;
  productId: string;
  background: string;
  prompt: string;
}>;

export const SHOWCASE_PRODUCT_IDS: readonly string[] = [
  "P001", "P002", "P003", "P004", "P005", "P006", "P007",
  "P008", "P009", "P010", "P011", "P012", "P013", "P014",
  "P015", "P016", "P017", "P018", "P019", "P020", "P021",
];

export const SHOWCASE_GROUPS: readonly ShowcaseGroup[] = [
  {
    id: "commute",
    title: "通勤精选",
    prompt: "帮我搭配一套适合通勤的穿搭，希望简洁利落，包含上装、下装和鞋履。",
    tiles: [
      { productId: "P001", label: "基础衬衫", background: "#eff3fa" },
      { productId: "P002", label: "西装外套", background: "#eeeafa" },
      { productId: "P008", label: "通勤裤装", background: "#f4eee9" },
      { productId: "P012", label: "乐福鞋", background: "#eef0f3" },
    ],
  },
  {
    id: "weekend",
    title: "轻松周末",
    prompt: "周末想出去走走，帮我搭配一套舒适、轻松的休闲穿搭。",
    tiles: [
      { productId: "P004", label: "日常T恤", background: "#eef5f4" },
      { productId: "P006", label: "牛仔外套", background: "#edf1fa" },
      { productId: "P010", label: "休闲牛仔", background: "#f5edfa" },
      { productId: "P018", label: "帆布鞋", background: "#f4f1e8" },
    ],
  },
  {
    id: "date",
    title: "温柔约会",
    prompt: "约会聚会想穿得温柔、优雅一些，请给我一套完整搭配，鞋子希望走路舒服。",
    tiles: [
      { productId: "P003", label: "柔软针织", background: "#f3eafa" },
      { productId: "P007", label: "A字半裙", background: "#f7ecee" },
      { productId: "P019", label: "平底乐福", background: "#f4ede7" },
      { productId: "P014", label: "搭配腰带", background: "#eef2ec" },
    ],
  },
  {
    id: "everyday",
    title: "日常轻行",
    prompt: "想要一套适合日常出游的百搭穿搭，鞋履轻便，配饰实用。",
    tiles: [
      { productId: "P009", label: "阔腿裤", background: "#f5f0e9" },
      { productId: "P011", label: "运动鞋", background: "#edf3ed" },
      { productId: "P015", label: "托特包", background: "#f2edf8" },
      { productId: "P021", label: "休闲鞋", background: "#eaf1f7" },
    ],
  },
  {
    id: "warm",
    title: "秋冬暖搭",
    prompt: "天气凉了，帮我搭配一套适合秋冬通勤的穿搭，重点是保暖和利落。",
    tiles: [
      { productId: "P005", label: "高领内搭", background: "#f0edf5" },
      { productId: "P013", label: "切尔西靴", background: "#f3e9e2" },
      { productId: "P016", label: "羊毛围巾", background: "#edf2ed" },
      { productId: "P020", label: "保暖短靴", background: "#edf0f5" },
    ],
  },
  {
    id: "essentials",
    title: "百搭基础",
    prompt: "我想从基础款开始搭配，希望简洁、舒适，适合日常和通勤。",
    tiles: [
      { productId: "P001", label: "基础上装", background: "#edf2f9" },
      { productId: "P008", label: "基础裤装", background: "#f3ede7" },
      { productId: "P017", label: "平底单鞋", background: "#f0eafa" },
      { productId: "P018", label: "日常帆布", background: "#edf3ee" },
    ],
  },
];

export const SHOWCASE_CHIPS: readonly ShowcaseChip[] = [
  { id: "tops", title: "上装精选", productId: "P003", background: "#b7a0e9", prompt: "我想看看适合自己的上装，请结合我的场景和偏好帮我选择。" },
  { id: "bottoms", title: "下装搭配", productId: "P009", background: "#e4bf59", prompt: "我想看看下装，帮我选择适合我的裤装或裙装，并说明怎么搭配。" },
  { id: "shoes", title: "舒适鞋履", productId: "P011", background: "#76b4a2", prompt: "我想看看舒适百搭的鞋履，请结合使用场景帮我选择。" },
  { id: "accessories", title: "日常配饰", productId: "P015", background: "#e297a4", prompt: "我想看看适合日常搭配的配饰，希望实用、容易搭配。" },
  { id: "commute", title: "日常通勤", productId: "P002", background: "#849bbf", prompt: "帮我搭一套日常通勤装，简单利落，走路舒服。" },
  { id: "weekend", title: "周末出游", productId: "P006", background: "#90bfc9", prompt: "帮我搭一套周末出游的穿搭，轻松一点，方便走路，有点层次感。" },
  { id: "date", title: "约会聚会", productId: "P007", background: "#c7aadf", prompt: "帮我搭一套约会聚会的穿搭，自然大方，不要太正式。" },
];
