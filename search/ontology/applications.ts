import type { Dimension } from "./common";

/**
 * P0-2 应用场景。标签必须来自业务文本里的产品/场景词,不是概念炒作;
 * 苹果生态只认文本里明确写出的 苹果/Apple(没有证据就没有标签)。
 */
export const applicationScenario: Dimension = {
  id: "applicationScenario",
  label: "应用场景",
  description: "公司产品/业务实际服务的下游场景",
  rules: [
    {
      value: "datacenter",
      label: "数据中心",
      patterns: ["数据中心", "IDC", "互联网数据中心", "机房", "智算中心", "算力中心", "云计算中心", "服务器"],
      rule: "app.datacenter.v2",
      confidence: 0.85,
    },
    {
      value: "ai_compute",
      label: "AI算力",
      patterns: ["算力", "智算", "人工智能", "AI服务器", "GPU", "加速卡", "大模型算力"],
      rule: "app.ai_compute.v2",
      confidence: 0.75,
    },
    {
      value: "semiconductor_mfg",
      label: "半导体制造",
      patterns: ["晶圆", "芯片制造", "集成电路制造", "封测", "封装测试", "半导体产线", "晶圆厂"],
      rule: "app.semiconductor_mfg.v2",
    },
    {
      value: "nev",
      label: "新能源汽车",
      patterns: ["新能源汽车", "电动汽车", "纯电动", "插电式混合动力", "增程式", "动力电池", "电驱动", "电驱系统", "车载充电", "充电桩", "整车控制器"],
      rule: "app.nev.v2",
      confidence: 0.85,
    },
    {
      value: "ess",
      label: "储能",
      patterns: ["储能", "电化学储能", "储能电站", "户用储能", "工商业储能"],
      rule: "app.ess.v2",
      confidence: 0.85,
    },
    {
      value: "solar",
      label: "光伏",
      patterns: ["光伏", "太阳能", "电池片", "光伏组件", "逆变器", "光伏电站", "硅片"],
      rule: "app.solar.v2",
      confidence: 0.85,
    },
    {
      value: "wind",
      label: "风电",
      patterns: ["风电", "风力发电", "风机整机", "叶片", "塔筒", "风电场", "海缆"],
      rule: "app.wind.v2",
      confidence: 0.85,
    },
    {
      value: "humanoid",
      label: "人形机器人",
      patterns: ["人形机器人", "仿生机器人", "双足机器人", "四足机器人", "具身智能"],
      rule: "app.humanoid.v2",
      confidence: 0.85,
    },
    {
      value: "industrial_robot",
      label: "工业机器人",
      patterns: ["工业机器人", "机械臂", "多关节机器人", "SCARA", "DELTA机器人", "协作机器人", "焊接机器人"],
      rule: "app.industrial_robot.v2",
      confidence: 0.85,
    },
    {
      value: "consumer_elec",
      label: "消费电子",
      patterns: ["消费电子", "智能手机", "智能手机组件", "可穿戴", "智能穿戴", "TWS耳机", "无线耳机", "平板电脑", "笔记本电脑", "AR", "VR", "智能音箱"],
      rule: "app.consumer_elec.v2",
    },
    {
      value: "apple_eco",
      label: "苹果生态",
      patterns: ["苹果", "Apple", "果链"],
      rule: "app.apple_eco.v2",
      confidence: 0.9,
    },
    {
      value: "grid",
      label: "电网",
      patterns: ["电网", "国家电网", "南方电网", "输配电", "变电站", "特高压", "配网", "智能电表"],
      rule: "app.grid.v2",
    },
    {
      value: "low_altitude",
      label: "低空经济",
      patterns: ["低空经济", "无人机", "eVTOL", "飞行汽车", "通航飞机"],
      rule: "app.low_altitude.v2",
    },
    {
      value: "satellite",
      label: "卫星通信",
      patterns: ["卫星", "星载", "卫星互联网", "相控阵", "天通", "北斗"],
      rule: "app.satellite.v2",
      confidence: 0.75,
    },
    {
      value: "medical_device",
      label: "医疗器械",
      patterns: ["医疗器械", "医用", "监护仪", "医学影像", "内窥镜", "骨科植入", "体外诊断", "诊断试剂", "呼吸机"],
      rule: "app.medical_device.v2",
    },
  ],
};
