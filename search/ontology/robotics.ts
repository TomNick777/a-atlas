import type { Dimension, NegativeRule } from "./common";

/**
 * P0-5 机器人细分。区分整机与核心零部件(减速器/伺服/丝杠/电机/传感器/
 * 灵巧手/机器视觉/结构件),防止「减速器厂」被当成「机器人整机厂」。
 */
export const roboticsSegment: Dimension = {
  id: "roboticsSegment",
  label: "机器人细分",
  description: "机器人产业链环节,整机与零部件分列",
  rules: [
    {
      value: "robot:reducer",
      label: "减速器",
      patterns: ["谐波减速器", "RV减速器", "行星减速器", "摆线针轮", "减速器"],
      rule: "robot.reducer.v2",
      confidence: 0.9,
    },
    {
      value: "robot:servo",
      label: "伺服/执行器",
      patterns: ["伺服电机", "伺服系统", "伺服驱动", "执行器", "电缸"],
      rule: "robot.servo.v2",
      confidence: 0.9,
    },
    {
      value: "robot:motor",
      label: "电机",
      patterns: ["空心杯电机", "无框电机", "无框力矩电机", "步进电机", "微特电机", "扁平电机", "直流电机", "驱动电机"],
      rule: "robot.motor.v2",
    },
    {
      value: "robot:lead_screw",
      label: "丝杠",
      patterns: ["滚珠丝杠", "行星滚柱丝杠", "丝杠", "梯形丝杠"],
      rule: "robot.lead_screw.v2",
      confidence: 0.9,
    },
    {
      value: "robot:sensor",
      label: "传感器",
      patterns: ["六维力", "六轴力", "力矩传感器", "力觉传感器", "触觉传感器", "编码器", "IMU", "惯性测量", "柔性传感"],
      rule: "robot.sensor.v2",
      confidence: 0.85,
    },
    {
      value: "robot:dexterous_hand",
      label: "灵巧手",
      patterns: ["灵巧手", "机械手", "末端执行器"],
      rule: "robot.dexterous_hand.v2",
      confidence: 0.8,
    },
    {
      value: "robot:machine_vision",
      label: "机器视觉",
      patterns: ["机器视觉", "视觉系统", "工业相机", "视觉检测", "视觉引导"],
      rule: "robot.machine_vision.v2",
    },
    {
      value: "robot:controller",
      label: "控制器",
      patterns: ["运动控制器", "机器人控制器", "控制器", "运动控制卡", "数控系统"],
      rule: "robot.controller.v2",
      confidence: 0.75,
    },
    {
      value: "robot:structural_parts",
      label: "结构件",
      patterns: ["机器人结构件", "关节模组", "精密结构件"],
      rule: "robot.structural.v2",
    },
    {
      value: "robot:whole_machine",
      label: "机器人整机",
      patterns: ["人形机器人", "四足机器人", "机器人本体", "具身智能", "工业机器人整机"],
      rule: "robot.whole.v2",
      confidence: 0.9,
    },
    {
      value: "robot:industrial_robot",
      label: "工业机器人",
      patterns: ["工业机器人", "机械臂", "多关节机器人", "SCARA", "DELTA", "协作机器人"],
      rule: "robot.industrial.v2",
      confidence: 0.85,
    },
  ],
};

export const roboticsNegatives: NegativeRule[] = [
  {
    concept: "robot:whole_machine",
    label: "非机器人整机厂",
    hasAny: ["robot:reducer", "robot:servo", "robot:motor", "robot:lead_screw", "robot:sensor", "robot:dexterous_hand"],
    hasNoneOf: ["robot:whole_machine", "robot:industrial_robot"],
    guardTextPatterns: ["机器人本体", "人形机器人", "四足机器人", "机器人整机", "机器人及", "机器人系统", "具身智能", "工业机器人"],
    because: "只有机器人核心零部件证据,无任何整机/本体词",
    rule: "robot.neg_whole.v2",
  },
];
