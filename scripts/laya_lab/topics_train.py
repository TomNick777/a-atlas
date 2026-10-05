"""Training topic families for the A-share Laya fine-tune (GLM-5.3-Flash, v1).

Family isolation: none of these topics appears in topics.py (frozen TEST/VAL).
Same labeling discipline: labels must be derivable from the company profile text;
tight primary patterns for level 3, secondary for 2, generic mentions for 1;
curated overrides only for companies whose text I verified.

Also defines CALIB_ABSORB: queries from the project's 2026-09 acceptance set
(data/raw/laya_calib.json, binary labels, teacher: previous acceptance round)
whose topics do not collide with TEST/VAL; absorbed into TRAIN as-is.
"""

from __future__ import annotations

from .data import has, match_text, ov
from .topics import (
    _m,
    _rule,
    _share_band,
    AI_PAT,
    AUTOPART_PAT,
    DC_PAT,
    ROBOT_PAT,
)

# ---- shared extra patterns --------------------------------------------------

WIND_OEM_PAT = r"风机|风电机组|风电整机|风力发电机组"
WIND_PART_PAT = r"叶片|塔筒|主轴|轮毂|偏航|变桨|风电轴承|海缆"
POWER_OPS_PAT = r"火电|燃煤发电|热电联产|水力发电|光伏电站|风力发电.{0,6}(运营|投资)"
BATTERY_CELL_PAT = r"动力电池|储能电池|锂离子电池(?!材料)|消费电池|电池(系统|组|制造|生产)"
MEDDEV_PAT = r"医疗器械|医用耗材|诊断试剂|医学影像|监护仪|骨科植入|心血管介入|微创(介入|器械)|体外诊断"
MACHtool_PAT = r"数控机床|加工中心|磨床|铣床|车床|机床"
SHIP_PAT = r"船舶(制造|修造|设计)|造船|海洋工程装备|集装箱船|散货船"
PANEL_PAT = r"显示面板|液晶面板|OLED面板|面板(制造|厂商)|显示模组|OLED(终端|材料)"
AUTO_OEM = r"整车|乘用车|商用车|轿车|SUV|客车|汽车制造|汽车生产"
THERMAL_PAT = r"汽车热管理|热泵|热交换|冷却水泵|电子风扇|空调系统"
GAME_PAT = r"游戏(研发|开发|运营|发行)|网络游戏|手游页游"
PORK_PAT = r"生猪|种猪|育肥猪|猪苗"
MEDBEAUTY_PAT = r"医美|医疗美容|玻尿酸|肉毒素|水光针|胶原蛋白|热玛吉"
PHOSCHEM_PAT = r"磷化工|磷矿石|磷酸一铵|磷酸二铵|磷酸铁|黄磷|精制磷酸"
H2_PAT = r"氢能|电解槽|加氢站|储氢|燃料电池电堆|质子交换膜"
CHARGE_PAT = r"充电桩|充电模块|充电枪|换电站|充电运营"
STORAGE_PAT = r"储能系统|储能集成|PCS|储能变流|电芯(?!材料)|电池系统"
SEMI_MAT_PAT = r"光刻胶|靶材|电子特气|电子气体|CMP|抛光垫|抛光液|湿电子化学品|掩膜版|硅片(?!电池)|电子级硅"
CAR_CHIP_PAT = r"车规级|车载芯片|汽车电子.{0,6}(芯片|器件)|车身控制|智能座舱|自动驾驶(芯片|域控制)"
GAME_HW_PAT = r"游戏(机|硬件|外设|设备)|电竞"
MEDBEAUTY_SVC_PAT = r"医美(服务|机构|医院|门诊)|医疗美容医院"
AVIATION_PAT = r"C919|大飞机|航空零部件|机轮|刹车系统|航电|机体结构|航空锻件"
DATAELEM_PAT = r"数据要素|数据交易所|数据资产|数据治理|大数据平台"
DEFENSE_PAT = r"军工|国防|武器装备|导弹|军用|特种装备|军品"
PHARMA_PAT = r"化学制药|生物制药|中药|原料药|制剂|药品"
AGING_PAT = r"养老|康复(器械|护理)|助行器|老年| Aging |抗衰老"
FOOD_PAT = r"食品(加工|制造|生产)|休闲食品|烘焙|肉制品|速冻"


def overseas_of(c):
    return _share_band(ov(c))


# ---- TRAIN families ----------------------------------------------------------

TRAIN_TOPICS: list[dict] = [
    {
        "family": "TR-IND-BEER",
        "category": "行业",
        "queries": ["啤酒公司", "做啤酒的企业", "主业卖啤酒的上市公司"],
        "label": lambda c: _rule(c, r"啤酒(的生产|生产销售|制造|的生产与销售|业务|酿造|生产及销售|的生产销售)", hit=3) or _rule(c, r"啤酒", hit=2),
        "curated": {
            "000869": (1, "张裕A:葡萄酒白兰地,非啤酒"),
            "002568": (1, "百润股份:预调酒+香精,非啤酒制造"),
        },
    },
    {
        "family": "TR-IND-PVOPS",
        "category": "行业",
        "queries": ["光伏电站运营公司", "做光伏电站投资运营的企业", "持有光伏电站的公司"],
        "label": lambda c: _rule(c, r"光伏电站.{0,10}(投资|运营|开发)|光伏发电.{0,8}(运营|投资|业务)|太阳能电站|光伏电站", hit=3)
        or _rule(c, r"光伏|太阳能", hit=1),
        "curated": {
            "000591": (3, "太阳能:光伏电站投资运营,光伏电池组件"),
            "000537": (3, "绿发电力:风能、太阳能投资开发运营"),
            "300274": (1, "阳光电源:制造逆变器,不持有电站为主"),
            "601012": (2, "隆基绿能:制造为主,兼有分布式电站"),
        },
    },
    {
        "family": "TR-IND-CELL",
        "category": "行业",
        "queries": ["锂电池制造公司", "做动力电池的企业", "电池厂", "类似宁德时代的公司", "和宁德时代做同类业务的企业"],
        "label": lambda c: _rule(c, r"动力电池|储能电池|锂离子电池|消费电池|电池系统", hit=3)
        or _rule(c, r"锂电", hit=1),
        "curated": {
            "300750": (3, "宁德时代:动力电池、储能电池"),
            "002074": (3, "国轩高科:动力电池系统、储能电池系统"),
            "001301": (1, "尚太科技:负极材料(上游材料,非电池厂)"),
            "002108": (1, "沧州明珠:隔膜(上游材料,非电池厂)"),
            "002460": (1, "赣锋锂业:锂盐(上游资源,非电池厂)"),
            "002240": (1, "盛新锂能:锂盐(上游资源)"),
            "002733": (2, "雄韬股份:电池制造(铅酸/锂电,规模较小)"),
        },
    },
    {
        "family": "TR-IND-MEDDEV",
        "category": "行业",
        "queries": ["医疗器械公司", "做医用设备耗材的企业", "主营医疗器械的上市公司"],
        "label": lambda c: _rule(c, MEDDEV_PAT, hit=3) or _rule(c, r"医疗|医用", hit=1),
        "curated": {},
    },
    {
        "family": "TR-IND-MACHtool",
        "category": "行业",
        "queries": ["数控机床公司", "做机床的企业", "主营数控机床的上市公司"],
        "label": lambda c: _rule(c, MACHtool_PAT, hit=3) or _rule(c, r"机床|机加工|切削", hit=1),
        "curated": {},
    },
    {
        "family": "TR-IND-SHIP",
        "category": "行业",
        "queries": ["造船公司", "做船舶制造的企业", "船厂"],
        "label": lambda c: _rule(c, SHIP_PAT, hit=3) or _rule(c, r"船舶|船用", hit=1),
        "curated": {},
    },
    {
        "family": "TR-IND-PANEL",
        "category": "行业",
        "queries": ["面板公司", "做显示面板的企业", "液晶面板OLED制造商", "类似京东方的公司"],
        "label": lambda c: _rule(c, PANEL_PAT, hit=3) or _rule(c, r"显示|液晶", hit=1),
        "curated": {
            "000725": (3, "京东方A:显示器件业务"),
            "001399": (3, "惠科股份:半导体显示面板"),
            "000100": (2, "TCL科技:半导体显示为主业之一(新能源光伏兼有)"),
            "000536": (3, "华映科技:显示面板、显示模组"),
        },
    },
    {
        "family": "TR-IND-AUTOOEM",
        "category": "行业",
        "queries": ["汽车整车厂", "做乘用车的企业", "造车的上市公司"],
        "label": lambda c: _rule(c, AUTO_OEM, hit=3) or _rule(c, AUTOPART_PAT, hit=1),
        "curated": {
            "002594": (3, "比亚迪:整车研发制造销售"),
            "000625": (3, "长安汽车:整车研发、制造和销售"),
            "000550": (3, "江铃汽车:商用车乘用车SUV"),
            "000800": (3, "一汽解放:商用车整车"),
            "000572": (3, "海马汽车:汽车及动力总成制造"),
            "000868": (3, "安凯客车:客车整车"),
            "000957": (3, "中通客车:客车制造"),
            "000980": (3, "众泰汽车:整车研发制造销售"),
            "000951": (3, "中国重汽:重型载重汽车"),
            "000887": (1, "中鼎股份:零部件商,不造整车"),
            "000589": (1, "贵州轮胎:轮胎(零部件),不造车"),
            "300124": (1, "汇川技术:汽车零部件/电控,不造整车"),
        },
    },
    {
        "family": "TR-IND-THERMALCAR",
        "category": "行业",
        "queries": ["汽车热管理公司", "做车载热管理部件的企业", "车用空调冷却系统厂商", "类似三花智控的公司"],
        "label": lambda c: _rule(c, r"汽车热管理|车用空调|热泵|热交换|冷却水泵|电子风扇", hit=3)
        or _rule(c, r"热管理|制冷|散热", hit=1),
        "curated": {
            "002050": (2, "三花智控:制冷控制部件,车用热管理为主要板块"),
            "002126": (3, "银轮股份:热管理产品(汽车热交换)"),
            "002239": (3, "奥特佳:汽车热管理系统零部件"),
            "002454": (3, "松芝股份:移动式热管理(车载空调)"),
            "002837": (1, "英维克:机房温控(数据中心,非车用)"),
        },
    },
    {
        "family": "TR-IND-THERMALPOWER",
        "category": "行业",
        "queries": ["火电公司", "做火力发电的企业", "燃煤电厂运营商"],
        "label": lambda c: _rule(c, r"火力发电|燃煤(发电|机组)|热电联产|火电", hit=3)
        or _rule(c, r"发电|电力生产", hit=1),
        "curated": {},
    },
    {
        "family": "TR-IND-WINDOEM",
        "category": "行业",
        "queries": ["风电整机厂", "做风电机组的企业", "风力发电机制造商"],
        "label": lambda c: _rule(c, WIND_OEM_PAT, hit=3) or _rule(c, r"风电|风力发电", hit=1),
        "curated": {},
    },
    {
        "family": "TR-CHAIN-WINDPART",
        "category": "产业链",
        "queries": ["风电零部件公司", "风电产业链上游做叶片塔筒的企业", "给风电整机供货的厂商"],
        "label": lambda c: _rule(c, WIND_PART_PAT, hit=3) or _rule(c, r"风电|风力发电", hit=1),
        "curated": {},
    },
    {
        "family": "TR-CHAIN-STORAGE",
        "category": "产业链",
        "queries": ["储能系统集成商", "储能产业链相关公司", "做储能变流和系统集成的企业"],
        "label": lambda c: _rule(c, STORAGE_PAT, hit=3) or _rule(c, r"储能", hit=1),
        "curated": {
            "300750": (2, "宁德时代:储能电池是主业之一(电芯环节)"),
            "002580": (3, "圣阳股份:储能电池及系统"),
        },
    },
    {
        "family": "TR-CHAIN-CHARGE",
        "category": "产业链",
        "queries": ["充电桩公司", "做充电设施的企业", "新能源汽车充电设备厂商"],
        "label": lambda c: _rule(c, CHARGE_PAT, hit=3) or _rule(c, r"充电", hit=1),
        "curated": {},
    },
    {
        "family": "TR-CHAIN-HYDROGEN",
        "category": "产业链",
        "queries": ["氢能公司", "氢燃料电池产业链企业", "做电解槽制氢设备的公司"],
        "label": lambda c: _rule(c, H2_PAT, hit=3) or _rule(c, r"氢", hit=1),
        "curated": {
            "000723": (2, "美锦能源:煤炭焦化为主,氢能产业链布局"),
        },
    },
    {
        "family": "TR-CHAIN-SEMIMAT",
        "category": "产业链",
        "queries": ["半导体材料公司", "做光刻胶、靶材、电子气体的企业", "给晶圆厂供材料的公司"],
        "label": lambda c: _rule(c, SEMI_MAT_PAT, hit=3) or _rule(c, r"半导体|集成电路|晶圆", hit=1),
        "curated": {
            "300346": (3, "南大光电:特气、光刻胶、前驱体"),
            "300054": (3, "鼎龙股份:CMP材料、晶圆光刻胶"),
            "688019": (2, "安集科技:抛光液(半导体材料)"),
            "002409": (2, "雅克科技:电子化学品(前驱体等)"),
            "688981": (1, "中芯国际:晶圆代工(材料采购方)"),
            "688012": (1, "中微公司:设备商(不是材料)"),
        },
    },
    {
        "family": "TR-CHAIN-CARCHIP",
        "category": "产业链",
        "queries": ["车规级芯片公司", "汽车电子半导体企业", "做车载芯片的公司"],
        "label": lambda c: _rule(c, CAR_CHIP_PAT, hit=3) or _rule(c, r"芯片|半导体", hit=1),
        "curated": {},
    },
    {
        "family": "TR-ATTR-NEWCO",
        "category": "属性",
        "queries": ["2024年以后上市的新公司", "次新股"],
        "label": lambda c: (
            None
            if not c.get("listedAt")
            else (3, f"上市日期:{c['listedAt']}")
            if c["listedAt"] >= "2024-01-01"
            else (0, f"上市日期:{c['listedAt']}")
        ),
        "curated": {},
    },
    {
        "family": "TR-ATTR-ZHEJIANG",
        "category": "属性",
        "queries": ["注册在浙江的公司"],
        "label": lambda c: (
            None
            if not c["region"]["province"]
            else (3, f"注册地:{c['region']['province']}")
            if c["region"]["province"] == "浙江"
            else (0, f"注册地:{c['region']['province']}")
        ),
        "curated": {},
    },
    {
        "family": "TR-ATTR-DEFENSE",
        "category": "属性",
        "queries": ["军工企业", "做国防军用装备的公司"],
        "label": lambda c: _rule(c, r"军工|国防|军用|武器装备|导弹|军品", hit=3)
        or ((1, "国防军工行业(民用为主)") if c.get("swLevel1Industry") == "国防军工" else None),
        "curated": {},
    },
    {
        "family": "TR-COMBO-PVOVERSEAS",
        "category": "组合",
        "queries": ["光伏相关且有海外业务的公司", "光伏行业里海外收入占比高的企业"],
        "label": lambda c: (
            lambda pv, s: None
            if not pv and s is None
            else (3, f"光伏:{pv};境外{s}%")
            if pv and s is not None and s >= 25
            else (2, f"光伏相关:{pv}" + (f",境外仅{s}%" if s is not None else ""))
            if pv
            else (1, f"海外{s}%但无光伏业务")
            if s is not None and s >= 25
            else None
        )(
            match_text(c, r"光伏|太阳能|光伏组件|硅片|电池片"),
            overseas_of(c),
        ),
        "curated": {},
    },
    {
        "family": "TR-COMBO-PHCHEM-NEV",
        "category": "组合",
        "queries": ["磷化工+新能源材料公司", "做磷酸铁的磷化工企业"],
        "label": lambda c: _rule(c, PHOSCHEM_PAT, hit=3) or _rule(c, r"磷|化工", hit=1),
        "curated": {},
    },
    {
        "family": "TR-COMBO-FOODEXPORT",
        "category": "组合",
        "queries": ["食品相关且有海外收入的公司", "食品出口企业"],
        "label": lambda c: (
            lambda food, s: None
            if not food and s is None
            else (3, f"食品:{food};境外{s}%")
            if food and s is not None and s >= 25
            else (2, f"食品相关:{food}" + (f",境外{s}%" if s is not None else ""))
            if food
            else (1, f"海外{s}%但非食品业")
            if s is not None and s >= 25
            else None
        )(
            match_text(c, FOOD_PAT),
            overseas_of(c),
        ),
        "curated": {},
    },
    {
        "family": "TR-COMBO-DEF-EXPORT",
        "category": "组合",
        "queries": ["军工+电子的公司", "做军用电子信息装备的企业"],
        "label": lambda c: _rule(c, r"军工电子|军用电子|军事通信|军用计算机", hit=3)
        or (
            (2, "国防军工行业,电子信息技术相关")
            if c.get("swLevel1Industry") == "国防军工" and has(c, r"电子|通信|雷达|计算机")
            else _rule(c, DEFENSE_PAT, hit=2)
        ),
        "curated": {},
    },
    {
        "family": "TR-NEG-WINDNOOEM",
        "category": "否定",
        "queries": ["风电相关,但不要整机厂", "和风电有关的公司,排除做风机整机的"],
        "label": lambda c: (
            lambda part, oem: None
            if not part and not oem
            else (0, f"风电整机厂,查询排除:{oem}")
            if oem and not part
            else (3, f"风电零部件:{part}")
            if part
            else (1, f"风电整机:{oem}(查询排除)")
        )(
            match_text(c, WIND_PART_PAT + r"|风电轴承|海缆|风电变流器"),
            match_text(c, WIND_OEM_PAT),
        ),
        "curated": {},
    },
    {
        "family": "TR-NEG-MEDBEAUTYNOSVC",
        "category": "否定",
        "queries": ["医美相关,但不要医美机构", "和医疗美容有关的公司,排除做诊所医院的"],
        "label": lambda c: (
            lambda up, svc: None
            if not up and not svc
            else (0, f"医美服务机构,被排除:{svc}")
            if svc and not up
            else (3, f"医美产品/上游:{up}")
            if up
            else (1, f"医美服务机构:{svc}(查询排除)")
        )(
            match_text(c, MEDBEAUTY_PAT + r"|玻尿酸|胶原蛋白|肉毒"),
            match_text(c, MEDBEAUTY_SVC_PAT),
        ),
        "curated": {},
    },
    {
        "family": "TR-NEG-GAMENOFIRM",
        "category": "否定",
        "queries": ["游戏相关,但不要游戏研发公司", "和游戏有关的公司,排除做游戏内容的"],
        "label": lambda c: (
            lambda dev, hw: None
            if not dev and not hw
            else (0, f"游戏研发/发行,被排除:{dev}")
            if dev and not hw
            else (3, f"游戏硬件/外设:{hw}")
            if hw
            else (1, f"游戏内容商:{dev}(查询排除)")
        )(
            match_text(c, GAME_PAT),
            match_text(c, GAME_HW_PAT),
        ),
        "curated": {},
    },
    {
        "family": "TR-FUZZ-AGING",
        "category": "模糊",
        "queries": ["老龄化受益的公司", "人口老龄化背景下有机会的企业"],
        "label": lambda c: _rule(c, MEDDEV_PAT + r"|养老|康复|老年|慢性病|保健", hit=3)
        or _rule(c, PHARMA_PAT, hit=2)
        or _rule(c, r"医疗|医药", hit=1),
        "curated": {},
    },
    {
        "family": "TR-FUZZ-HEATWAVE",
        "category": "模糊",
        "queries": ["高温天气受益的公司", "极端高温下生意会变好的企业"],
        "label": lambda c: _rule(c, r"火力发电|水力发电|电力生产|空调|制冷|啤酒|饮料|饮用水|防晒", hit=3)
        or _rule(c, r"电力|电网", hit=2),
        "curated": {},
    },
    {
        "family": "TR-FUZZ-BIGPLANE",
        "category": "模糊",
        "queries": ["国产大飞机供应链的公司", "C919产业链企业"],
        "label": lambda c: _rule(c, AVIATION_PAT, hit=3) or _rule(c, r"航空|飞机", hit=1),
        "curated": {},
    },
    {
        "family": "TR-FUZZ-DATAELEM",
        "category": "模糊",
        "queries": ["数据要素概念的公司", "做数据资产和大数据平台的企业"],
        "label": lambda c: _rule(c, DATAELEM_PAT, hit=3) or _rule(c, r"大数据|数据服务|数据库", hit=2)
        or _rule(c, r"软件|信息技术", hit=1),
        "curated": {},
    },
    {
        "family": "TR-CHAIN-BATTEQUIP",
        "category": "产业链",
        "queries": ["锂电池生产设备公司", "电池行业卖铲子的公司", "做电池自动化产线的企业"],
        "label": lambda c: _rule(c, r"锂电池?自动化(装备|设备)|电池.{0,4}智能装备|锂电池生产设备|新能源电池.{0,6}设备", hit=3)
        or _rule(c, r"电池设备|智能装备|自动化装备", hit=2)
        or _rule(c, r"锂离子电池|动力电池|储能电池", hit=1),
        "curated": {
            "300457": (3, "赢合科技:锂电池自动化装备与服务"),
            "300619": (3, "金银河:新能源电池智能装备制造"),
            "300173": (2, "ST福能:新能源电池自动化设备整线(聚焦但含精密制造)"),
            "002192": (2, "融捷股份:锂矿锂盐为主,锂电池设备制造为辅"),
            "002076": (2, "星光股份:多业混杂,含锂电池生产设备"),
            "300750": (1, "宁德时代:电池厂,是设备的采购方"),
            "002074": (1, "国轩高科:电池厂(采购方)"),
        },
    },
    {
        "family": "TR-IND-PHARMA",
        "category": "行业",
        "queries": ["化学制药公司", "做西药原料药制剂的企业", "医药企业里做化学制药的,不要中药"],
        "label": lambda c: _rule(c, r"化学制药|化学药品|原料药|生物(制药|医药制品)|制剂|创新药", hit=3)
        or _rule(c, r"中药", hit=1)
        or _rule(c, r"医药", hit=1),
        "curated": {
            "000597": (3, "东北制药:化学制药板块"),
            "000739": (3, "普洛药业:原料药中间体、药品"),
            "000623": (2, "吉林敖东:中药+化学药品双板块"),
            "000590": (1, "古汉医药:中药为主(查询排除中药)"),
            "000153": (2, "丰原药业:医药制造和流通(未明写化药)"),
            "000705": (1, "浙江震元:医药流通为主"),
        },
    },
    {
        "family": "TR-IND-CEMFG",
        "category": "行业",
        "queries": ["消费电子代工厂", "做电子产品OEM制造的企业"],
        "label": lambda c: _rule(c, r"消费电子.{0,12}(研发|生产|制造|设计|组装)|电子制造服务|EMS|代工", hit=3)
        or _rule(c, r"消费电子|智能终端", hit=2),
        "curated": {
            "002475": (3, "立讯精密:消费电子零组件模组制造"),
            "002369": (3, "卓翼科技:网络通讯、消费电子生产制造"),
            "002426": (3, "胜利精密:消费电子结构模组制造"),
            "002241": (3, "歌尔股份:声学/智能硬件制造"),
            "002577": (1, "雷柏科技:自有品牌运营,非代工"),
            "000016": (2, "*ST康佳A:自有品牌为主,兼代工与半导体"),
            "002032": (1, "苏泊尔:厨房小家电品牌(自研自销,非EMS)"),
        },
    },
    {
        "family": "TR-COMBO-CHARGE-EXPORT",
        "category": "组合",
        "queries": ["充电桩相关且有海外业务的公司", "充电设备出口企业"],
        "label": lambda c: (
            lambda ch, s: None
            if not ch and s is None
            else (3, f"充电:{ch};境外{s}%")
            if ch and s is not None and s >= 20
            else (2, f"充电相关:{ch}" + (f",境外仅{s}%" if s is not None else ""))
            if ch
            else (1, f"海外{s}%但无充电业务")
            if s is not None and s >= 20
            else None
        )(
            match_text(c, r"充电桩|充电模块|充电枪|充电设备|充电运营|换电"),
            overseas_of(c),
        ),
        "curated": {},
    },
]

# 2026-09 验收校准集里与 TEST/VAL 主题不冲突的查询,原样并入 TRAIN。
# 标签是当时的验收标注(0/1),provenance 记录原始来源。
CALIB_ABSORB = {
    "做光刻胶的公司": "TR-CHAIN-SEMIMAT",
    "主营汽车动力系统": "TR-COMBO-AUTOPOWER",
    "山东的高端制造企业": "TR-ATTR-SHANDONG",
    "给半导体厂提供耗材，但本身不制造芯片": "TR-CHAIN-SEMIMAT",
}
