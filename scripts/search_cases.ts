export type AcceptanceCase = {
  query: string;
  expect: string[];
  exclude: string[];
  province?: string;
};

export const CASES: AcceptanceCase[] = [
  { query: "做光刻胶的公司", expect: ["彤程新材", "南大光电", "晶瑞电材", "容大感光"], exclude: ["中芯国际"] },
  {
    query: "给 AI 数据中心卖铲子的公司，但不要纯软件公司",
    expect: ["工业富联", "中际旭创", "沪电股份", "英维克"],
    exclude: ["金山办公", "用友网络"],
  },
  { query: "主营汽车动力系统", expect: ["潍柴动力", "ST云动", "蓝黛科技"], exclude: ["长安汽车"] },
  { query: "山东的高端制造企业", expect: ["潍柴动力", "豪迈科技"], exclude: [], province: "山东" },
  { query: "给半导体厂提供耗材，但本身不制造芯片", expect: ["鼎龙股份", "安集科技", "雅克科技"], exclude: ["中芯国际", "华虹宏力"] },
  { query: "做机器人产业链，但主营业务确实相关", expect: ["埃斯顿", "绿的谐波", "双环传动"], exclude: [] },
  { query: "央国企、电力设备、现金流相对稳定", expect: ["国电南瑞", "许继电气", "平高电气"], exclude: [] },
  { query: "海外收入较高的制造业公司", expect: ["三一重工", "中集集团"], exclude: [] },
];
